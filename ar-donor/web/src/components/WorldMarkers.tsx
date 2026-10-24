import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useXR, useXRHitTest, useXRAnchor } from "@react-three/xr";
import { Billboard, Text } from "@react-three/drei";
import { Group, Matrix4, Quaternion, Vector3 } from "three";
import type { Annotation } from "../lib/useWebRTC";

/**
 * World-anchored 6DoF component markers (Goal 2 / Goal 3, T2 tier).
 *
 * Strictly ADDITIVE: this only renders inside an active immersive-ar session.
 * On desktop, phones, and 3DoF display glasses there is no session, so this is a
 * no-op and the 2D <AnnotationOverlay> stays the universal baseline — the working
 * screen-space highlights are never disturbed.
 *
 * How a 2D Gemini box becomes a world-locked label:
 *   1. A viewer-space hit test continuously reports how far the real surface is
 *      in front of the technician (T2 devices grant hit-test; T1 falls back to a
 *      comfortable fixed distance).
 *   2. When a NEW annotation arrives, we capture the headset pose ONCE and project
 *      the box centre into world space at the surface distance. That world point
 *      is fixed — as the technician moves their head, the marker stays put. That
 *      is the 6DoF win (vs. the head-locked 2D overlay).
 *   3. Best-effort, we also create a real XRAnchor at that point and, while it
 *      tracks, drive the marker from the anchor pose so it survives tracking
 *      refinement / drift. If anchors are unsupported, the captured point remains
 *      authoritative — the marker is still world-locked.
 *
 * Build-verified against @react-three/xr 6 + drei 10 types; on-device behaviour
 * is exercised on the headset.
 */

// Approximate camera FOV used to fan box-centre offsets out around the forward
// ray. The Billboard makes labels face the user regardless, so small projection
// error just nudges a marker's bearing — it never makes one face the wrong way.
const HFOV = (60 * Math.PI) / 180;
const VFOV = (40 * Math.PI) / 180;
const DEFAULT_DISTANCE = 1.2; // metres, when no hit-test surface is available
const MIN_DISTANCE = 0.3;
const MAX_DISTANCE = 8.0;
// Box-centre move (in the 0-1000 normalized space) beyond which a same-label
// re-annotation is treated as a real RE-PLACEMENT rather than detection jitter.
// Below it the marker stays pinned (no head-follow jump); above it, it re-settles
// onto the corrected target so the 3D marker can't desync from the 2D overlay.
const REPLACE_THRESHOLD = 120;

interface SurfaceRef {
  distance: number;
  valid: boolean;
}

// Reused scratch objects for the per-frame viewer hit-test callback. Hoisted to
// module scope so the 72-90 Hz headset hot path allocates nothing (no GC churn /
// frame-time jitter). Safe: the callback runs sequentially on the main thread.
const _hitMatrix = new Matrix4();
const _hitPos = new Vector3();
const _camPos = new Vector3();

export function WorldMarkers({ annotations }: { annotations: Annotation[] }) {
  // Gate on an actual immersive session — no session => the 2D overlay is the UI.
  const session = useXR((s) => s.session);
  const surfaceRef = useRef<SurfaceRef>({ distance: DEFAULT_DISTANCE, valid: false });
  const camera = useThree((s) => s.camera);

  // Viewer-space hit test: keep the latest real-surface distance fresh so newly
  // placed markers land on the surface the technician is looking at (T2). On T1
  // (no hit-test granted) this callback simply never fires and we use the default.
  useXRHitTest((results, getWorldMatrix) => {
    if (!results.length) return;
    if (!getWorldMatrix(_hitMatrix, results[0])) return;
    _hitPos.setFromMatrixPosition(_hitMatrix);
    const d = _hitPos.distanceTo(camera.getWorldPosition(_camPos));
    if (Number.isFinite(d) && d >= MIN_DISTANCE && d <= MAX_DISTANCE) {
      surfaceRef.current = { distance: d, valid: true };
    }
  }, "viewer");

  if (!session) return null;

  return (
    <group>
      {annotations.map((a) => (
        <WorldMarker key={a.id} annotation={a} surfaceRef={surfaceRef} />
      ))}
    </group>
  );
}

function clampDistance(d: number): number {
  return Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, d));
}

/** One world-locked label. Locks its world bearing once at first sight, settles
 *  its depth onto the real surface as soon as hit-test data is available, then
 *  (best-effort) hard-anchors to that settled point via an XRAnchor. */
function WorldMarker({
  annotation,
  surfaceRef,
}: {
  annotation: Annotation;
  surfaceRef: React.MutableRefObject<SurfaceRef>;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const groupRef = useRef<Group>(null);
  const [anchor, createAnchor] = useXRAnchor();

  // Derive the world BEARING (origin + rayDir) from a box + the CURRENT head pose.
  // Decomposing into origin + rayDir gives position(d) = origin + d * rayDir: the
  // direction is locked, but the DEPTH d can be resolved later. (The box-centre
  // offsets scale with d, so they fold cleanly into rayDir — the marker always
  // lies on this one ray from the capture origin.) `center` is the box centre in
  // 0-1000 space, used to detect a real move vs. jitter.
  const computeCap = (box: [number, number, number, number]) => {
    const [ymin, xmin, ymax, xmax] = box;
    const cx = (xmin + xmax) / 2 / 1000; // 0..1 left->right
    const cy = (ymin + ymax) / 2 / 1000; // 0..1 top->bottom
    const origin = camera.getWorldPosition(new Vector3());
    const quaternion = camera.getWorldQuaternion(new Quaternion());
    const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
    const right = new Vector3(1, 0, 0).applyQuaternion(quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(quaternion);
    const kx = (cx - 0.5) * 2 * Math.tan(HFOV / 2);
    const ky = (0.5 - cy) * 2 * Math.tan(VFOV / 2); // image y grows downward
    const rayDir = forward.add(right.multiplyScalar(kx)).add(up.multiplyScalar(ky));
    return {
      origin,
      rayDir,
      quaternion,
      center: [(xmin + xmax) / 2, (ymin + ymax) / 2] as [number, number],
    };
  };

  // Captured bearing for the CURRENT placement. Lazily initialised once, then
  // re-captured only when the box moves past REPLACE_THRESHOLD (see useFrame).
  const capRef = useRef<ReturnType<typeof computeCap> | null>(null);
  if (capRef.current === null) capRef.current = computeCap(annotation.box);

  const posAt = (d: number): Vector3 =>
    capRef.current!.origin.clone().add(capRef.current!.rayDir.clone().multiplyScalar(clampDistance(d)));

  // The settled world point. Resolved as soon as a real hit-test surface distance
  // is available, else after a short window using the fallback distance. Because
  // the stable annotation id keeps this marker mounted across refreshes, settling
  // here (not at mount) is what lets a marker that appeared during the cold-start
  // window — before any hit-test result — still snap onto the real surface instead
  // of locking to the 1.2 m fallback forever.
  const settledRef = useRef<Vector3 | null>(null);
  const deadlineRef = useRef(0);
  const anchorRequested = useRef(false);

  useFrame((state, _delta, frame?: XRFrame) => {
    const g = groupRef.current;
    if (!g) return;

    // 0) Re-placement vs. jitter. A same-label refresh normally keeps the marker
    //    pinned (so detection noise / head motion never makes it jump). But if the
    //    box CENTRE moved substantially, that's a real correction (the part slid,
    //    or the model fixed a misdetection) — re-capture from the current head pose
    //    so the 3D marker tracks the same target the 2D overlay just moved to,
    //    instead of staying stuck at the original spot.
    const [ymin, xmin, ymax, xmax] = annotation.box;
    const bx = (xmin + xmax) / 2;
    const by = (ymin + ymax) / 2;
    const [px, py] = capRef.current!.center;
    if (Math.hypot(bx - px, by - py) > REPLACE_THRESHOLD) {
      capRef.current = computeCap(annotation.box);
      settledRef.current = null;
      deadlineRef.current = 0;
      anchorRequested.current = false;
    }
    const cap = capRef.current!;
    const s = surfaceRef.current;

    // 1) Settle the depth once per placement.
    if (settledRef.current === null) {
      if (!deadlineRef.current) deadlineRef.current = state.clock.elapsedTime + 0.6;
      if (s.valid) settledRef.current = posAt(s.distance);
      else if (state.clock.elapsedTime >= deadlineRef.current) settledRef.current = posAt(DEFAULT_DISTANCE);
      if (settledRef.current === null) {
        g.position.copy(posAt(s.valid ? s.distance : DEFAULT_DISTANCE)); // provisional
        return;
      }
    }
    const settled = settledRef.current;

    // 2) Best-effort: register ONE real anchor at the settled (correct) point so a
    //    6DoF device hard-pins it. Unsupported -> the settled point stays authoritative.
    if (!anchorRequested.current) {
      anchorRequested.current = true;
      createAnchor({
        relativeTo: "world",
        worldPosition: settled,
        worldQuaternion: cap.quaternion,
      }).catch(() => {
        /* anchors unsupported — settled world point remains authoritative */
      });
    }

    // 3) Drive from the tracked anchor pose when available (survives tracking
    //    refinement / drift); otherwise hold the settled world point.
    if (anchor && frame) {
      try {
        const refSpace = gl.xr.getReferenceSpace();
        if (refSpace) {
          const pose = frame.getPose(anchor.anchorSpace, refSpace);
          if (pose) {
            const p = pose.transform.position;
            g.position.set(p.x, p.y, p.z);
            return;
          }
        }
      } catch {
        /* fall through to the settled point */
      }
    }
    g.position.copy(settled);
  });

  const labelText =
    annotation.detail && annotation.detail.trim()
      ? `${annotation.label}  ·  ${annotation.detail}`
      : annotation.label;
  // Severity colour, matching the 2D overlay palette (info/warn/danger).
  const markColor =
    annotation.level === "danger" ? "#e5484d" : annotation.level === "warn" ? "#f4c542" : "#19c37d";

  return (
    <group ref={groupRef} position={posAt(DEFAULT_DISTANCE).toArray()}>
      <Billboard>
        {/* highlight ring marking the exact component point */}
        <mesh>
          <ringGeometry args={[0.05, 0.065, 40]} />
          <meshBasicMaterial color={markColor} transparent opacity={0.95} toneMapped={false} />
        </mesh>
        {/* label chip floating just above the ring */}
        <group position={[0, 0.13, 0]}>
          <mesh position={[0, 0, -0.002]}>
            <planeGeometry args={[Math.max(0.18, labelText.length * 0.018), 0.075]} />
            <meshBasicMaterial color="#0b0f14" transparent opacity={0.78} toneMapped={false} />
          </mesh>
          <Text
            fontSize={0.035}
            color="#f5f7fa"
            anchorX="center"
            anchorY="middle"
            maxWidth={0.6}
            outlineWidth={0.002}
            outlineColor="#0b0f14"
          >
            {labelText}
          </Text>
        </group>
      </Billboard>
    </group>
  );
}
