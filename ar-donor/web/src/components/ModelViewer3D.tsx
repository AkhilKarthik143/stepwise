import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Bounds, Center, Html, useBounds } from "@react-three/drei";
import type { Group } from "three";

// Lazily pulled in only when a diagram references a pre-built model, so the
// GLTFLoader never weighs down the primitive-only 3D path.
const GltfModel = lazy(() => import("./GltfModel"));

/** Renders its children unless they throw (a GLTF load/parse failure) — then
 *  renders nothing, so the primitive diagram (outside this boundary) remains.
 *  Key it by URL so a new asset gets a fresh attempt. */
class AssetErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Re-fit the Bounds camera once a pre-built model finishes loading (it resolves
 *  async INSIDE <Bounds>/<Center>, which otherwise framed the primitives only).
 *  Lives inside <Bounds> so it can reach the bounds api. No-op until trigger>0. */
function AssetReframe({ trigger }: { trigger: number }) {
  const bounds = useBounds();
  useEffect(() => {
    if (trigger > 0) bounds.refresh().clip().fit();
  }, [trigger, bounds]);
  return null;
}
import {
  modelColorHex,
  isEmphasized,
  stepPhase,
  resolveActiveStep,
  type ModelPart,
  type ModelSpec,
} from "../lib/solutionModel";
import { torusTube, labelReach } from "../lib/solutionGeometry";

// Lazily-loaded on purpose: this module statically imports the three + r3f +
// drei stack, so it must stay behind App's lazy boundary (SolutionPanel wraps it
// in Suspense). Keeping it out of the eager entry chunk preserves first paint.

const DEG = Math.PI / 180;
const ZERO3: [number, number, number] = [0, 0, 0];

interface Surface {
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  /** Translucency a material implies on its own (glass), before any explicit
   *  per-part opacity or step-dimming. 1 = opaque. */
  baseOpacity: number;
}

/** PBR finish for a part. An explicit `material` wins; otherwise fall back to the
 *  colour-derived finish (so pre-material diagrams look exactly as before). */
function surface(part: ModelPart): Surface {
  switch (part.material) {
    case "metal":
      return { metalness: 0.95, roughness: 0.3, clearcoat: 0, clearcoatRoughness: 0.5, baseOpacity: 1 };
    case "plastic":
      return { metalness: 0, roughness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.3, baseOpacity: 1 };
    case "rubber":
      return { metalness: 0, roughness: 0.95, clearcoat: 0, clearcoatRoughness: 0.5, baseOpacity: 1 };
    case "glass":
      return { metalness: 0, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.1, baseOpacity: 0.28 };
    case "painted":
      return { metalness: 0.1, roughness: 0.55, clearcoat: 0.4, clearcoatRoughness: 0.4, baseOpacity: 1 };
    default:
      // No explicit material — keep the legacy colour-derived finish.
      if (part.color === "metal" || part.color === "steel")
        return { metalness: 0.85, roughness: 0.35, clearcoat: 0, clearcoatRoughness: 0.5, baseOpacity: 1 };
      return { metalness: 0.1, roughness: 0.6, clearcoat: 0, clearcoatRoughness: 0.5, baseOpacity: 1 };
  }
}

function Primitive({
  part,
  emphasized,
  dimmed,
  showNote,
  paused,
  selectable,
  onSelect,
}: {
  part: ModelPart;
  emphasized: boolean;
  dimmed: boolean;
  /** Float this part's note on its label. Gated to the single-focused-part case
   *  by the parent so several emphasized parts can't pile notes over the view. */
  showNote: boolean;
  /** Freeze looping motion (user toggle / prefers-reduced-motion). */
  paused: boolean;
  /** True when this part should be a tap target (decided by the parent from the
   *  legend set, so every tappable part also has a keyboard-reachable legend row). */
  selectable: boolean;
  /** Tap handler (already drag-guarded by the parent). */
  onSelect?: (part: ModelPart, e: ThreeEvent<MouseEvent>) => void;
}) {
  const [px, py, pz] = part.position;
  const [sx, sy, sz] = part.size;
  const [rx, ry, rz] = part.rotation;
  const hex = modelColorHex(part.color);
  const s = surface(part);
  // A see-through part (explicit opacity, or a glass material's translucent base)
  // lets the tech see the parts INSIDE a housing; dimming a future step forces it
  // faint regardless. depthWrite off while transparent avoids sort artefacts.
  const opacity = dimmed ? 0.16 : part.opacity ?? s.baseOpacity;
  const transparent = opacity < 1;
  // Emphasis (highlight_model_part / the current playback step) self-illuminates
  // the part + grows it a touch so the eye lands there. A transparent surface
  // composites its emissive at ~alpha strength, so boost the intensity by 1/alpha
  // (divisor floored) for a see-through part — keeping the highlight as strong as
  // on a solid part WITHOUT forcing it opaque (which would hide the internals a
  // glass housing exists to reveal). Dimmed (future) parts are never emphasized.
  const emi = emphasized ? (transparent ? 0.9 / Math.max(opacity, 0.2) : 0.9) : 0;
  const matProps = {
    color: hex,
    metalness: s.metalness,
    roughness: s.roughness,
    clearcoat: s.clearcoat,
    clearcoatRoughness: s.clearcoatRoughness,
    emissive: hex,
    emissiveIntensity: emi,
    transparent,
    opacity,
    depthWrite: !transparent,
  };
  const mat = <meshPhysicalMaterial {...matProps} />;

  // Looping motion (demonstrate an action). The animated group sits at the pivot
  // and its child re-centres the geometry (pivot - pivot = part centre), so a
  // 'swing' rotates about the pivot (e.g. a scissor blade's joint). Each frame we
  // write ABSOLUTE transforms from the base pose => no drift; paused/dimmed/
  // un-animated parts rest at the base. The label is OUTSIDE this group, so the
  // annotation stays readable while the part moves.
  const animRef = useRef<Group>(null);
  const a = part.animate;
  const pv: [number, number, number] = a?.pivot
    ? [a.pivot[0] ?? 0, a.pivot[1] ?? 0, a.pivot[2] ?? 0]
    : ZERO3;
  const pvNeg: [number, number, number] = [-pv[0], -pv[1], -pv[2]];
  useFrame((state) => {
    const g = animRef.current;
    if (!g || !a) return; // non-animated parts keep their static prop pose
    g.rotation.set(0, 0, 0);
    g.scale.setScalar(1);
    g.position.set(pv[0], pv[1], pv[2]);
    if (paused || dimmed) return; // rest at base pose
    const t = state.clock.elapsedTime * (a.speed ?? 1);
    const ax = (a.axis === "x" || a.axis === "z" ? a.axis : "y") as "x" | "y" | "z";
    if (a.type === "spin") {
      g.rotation[ax] = t;
    } else if (a.type === "swing") {
      g.rotation[ax] = Math.sin(t) * Math.min(180, Math.abs(a.amount ?? 30)) * DEG;
    } else if (a.type === "slide") {
      g.position[ax] += Math.sin(t) * Math.min(50, Math.abs(a.amount ?? 0.5));
    } else if (a.type === "pulse") {
      // Floor at 0.05 so a strong pulse (amount up to 1) can't collapse the part
      // to an invisible zero-scale at the trough.
      g.scale.setScalar(Math.max(0.05, 1 + Math.sin(t) * Math.min(1, Math.abs(a.amount ?? 0.15))));
    }
  });

  let geom: React.ReactNode;
  switch (part.shape) {
    case "cylinder":
      geom = (
        <mesh>
          <cylinderGeometry args={[sx / 2, sx / 2, sy, 28]} />
          {mat}
        </mesh>
      );
      break;
    case "sphere":
      geom = (
        <mesh>
          <sphereGeometry args={[sx / 2, 28, 18]} />
          {mat}
        </mesh>
      );
      break;
    case "cone":
      geom = (
        <mesh>
          <coneGeometry args={[sx / 2, sy, 28]} />
          {mat}
        </mesh>
      );
      break;
    case "torus":
      geom = (
        <mesh>
          <torusGeometry args={[sx / 2, torusTube(sx, sy), 16, 36]} />
          {mat}
        </mesh>
      );
      break;
    case "plane":
      geom = (
        <mesh>
          <planeGeometry args={[sx, sy]} />
          {/* Double-sided so a thin panel is visible from behind too. */}
          <meshPhysicalMaterial {...matProps} side={2} />
        </mesh>
      );
      break;
    case "arrow":
      // Shaft + head, pointing +Y by default (rotation reorients it).
      geom = (
        <group>
          <mesh position={[0, -sy * 0.15, 0]}>
            <cylinderGeometry args={[sx * 0.12, sx * 0.12, sy * 0.7, 18]} />
            {mat}
          </mesh>
          <mesh position={[0, sy * 0.45, 0]}>
            <coneGeometry args={[sx * 0.28, sy * 0.3, 22]} />
            {mat}
          </mesh>
        </group>
      );
      break;
    case "box":
    default:
      geom = (
        <mesh>
          <boxGeometry args={[sx, sy, sz]} />
          {mat}
        </mesh>
      );
      break;
  }

  // The label hangs in WORLD-up at the part's centre, OUTSIDE the rotated group,
  // so it stays readable above the part for any rotation. Its height is the
  // part's bounding reach (per-shape), so it clears the mesh whatever the size.
  const labelY = labelReach(part.shape, part.size) + 0.18;
  return (
    <group
      position={[px, py, pz]}
      scale={emphasized ? 1.08 : 1}
      onClick={selectable && onSelect ? (e) => onSelect(part, e) : undefined}
    >
      {/* animation group (pivot) -> re-centre -> static per-part rotation -> geom */}
      <group ref={animRef} position={pv}>
        <group position={pvNeg}>
          <group rotation={[rx * DEG, ry * DEG, rz * DEG]}>{geom}</group>
        </group>
      </group>
      {part.label ? (
        <Html
          position={[0, labelY, 0]}
          center
          distanceFactor={8}
          pointerEvents="none"
          style={{ pointerEvents: "none" }}
          zIndexRange={[0, 0]}
        >
          <span
            className={`model3d-label${emphasized ? " model3d-label--em" : ""}${
              dimmed ? " model3d-label--dim" : ""
            }`}
          >
            {part.label}
            {/* The single focused part explains itself — its note appears under
                the name so the tech doesn't have to map back to the legend.
                Gated to one part (showNote) so a multi-part highlight / step
                can't stack notes across the view; the legend still has them all. */}
            {showNote && part.note ? (
              <span className="model3d-label__note">{part.note}</span>
            ) : null}
          </span>
        </Html>
      ) : null}
    </group>
  );
}

/** Orbit-able 3D assembly auto-framed to fill the view. `paused` freezes any
 *  looping part motion (user toggle / prefers-reduced-motion). `onSelect` opens
 *  the detail popover when a part with tap-data is tapped (drag-guarded so an
 *  orbit isn't read as a tap). */
export default function ModelViewer3D({
  spec,
  paused = false,
  onSelect,
  selectable,
}: {
  spec: ModelSpec;
  paused?: boolean;
  onSelect?: (part: ModelPart) => void;
  /** Parts that are tap targets (the legend set, so each also has a keyboard
   *  path). When omitted, falls back to "has spec/warning". */
  selectable?: ReadonlySet<ModelPart>;
}) {
  const resolvedStep = resolveActiveStep(spec.parts, spec.activeStep);
  const emphasizedOf = (part: ModelPart): boolean =>
    isEmphasized(part, spec.emphasis) || stepPhase(part, resolvedStep) === "current";
  // The floating note is for the ONE part in focus. Many parts can be emphasized
  // at once (highlight_model_part takes a list; a playback step holds several
  // parts), so only float the note when exactly one is focused — otherwise the
  // legend (which always carries every note) is where the tech reads them.
  const focusCount = spec.parts.filter(emphasizedOf).length;
  // Drag-vs-tap guard: record the pointer-down position; a mesh click only
  // selects if the pointer barely moved (else it was an OrbitControls drag). The
  // slop is wider for touch — a deliberate finger tap jitters ~8-10px.
  const downRef = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const onPartClick = (part: ModelPart, e: ThreeEvent<MouseEvent>) => {
    const d = downRef.current;
    const slop = d?.touch ? 12 : 6;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > slop) return; // it was a drag
    e.stopPropagation(); // only the front-most part selects
    onSelect?.(part);
  };
  const isSelectable = (part: ModelPart): boolean =>
    !!onSelect && (selectable ? selectable.has(part) : !!(part.spec?.length || part.warning));
  // Bumped once the pre-built model mounts, to re-center (Center cacheKey) and
  // re-fit (AssetReframe) the camera around it; reset when the asset changes.
  const [assetReady, setAssetReady] = useState(0);
  const onAssetReady = useCallback(() => setAssetReady((k) => k + 1), []);
  useEffect(() => setAssetReady(0), [spec.asset?.url]);
  return (
    <Canvas
      camera={{ position: [2.6, 2.0, 3.2], fov: 45 }}
      gl={{ alpha: true, antialias: true }}
      dpr={[1, 2]}
      style={{ width: "100%", height: "100%" }}
      onPointerDown={(e) => {
        downRef.current = { x: e.clientX, y: e.clientY, touch: e.pointerType === "touch" };
      }}
    >
      <ambientLight intensity={0.9} />
      <directionalLight position={[5, 8, 5]} intensity={1.1} />
      <directionalLight position={[-4, -2, -3]} intensity={0.35} />
      <Bounds fit clip observe margin={1.25}>
        <AssetReframe trigger={assetReady} />
        <Center cacheKey={assetReady}>
          {/* Pre-built model (if any) as the base; the AI's primitive parts then
              render over it as labelled call-outs. A load failure falls back to
              the primitives via the error boundary. */}
          {spec.asset?.url ? (
            <AssetErrorBoundary key={spec.asset.url}>
              <Suspense fallback={null}>
                <GltfModel url={spec.asset.url} onReady={onAssetReady} />
              </Suspense>
            </AssetErrorBoundary>
          ) : null}
          {spec.parts.map((part, i) => {
            const phase = stepPhase(part, resolvedStep);
            const emphasized = emphasizedOf(part);
            return (
              <Primitive
                key={i}
                part={part}
                emphasized={emphasized}
                dimmed={phase === "future" && !emphasized}
                showNote={emphasized && focusCount === 1}
                paused={paused}
                selectable={isSelectable(part)}
                onSelect={onSelect ? onPartClick : undefined}
              />
            );
          })}
        </Center>
      </Bounds>
      <OrbitControls makeDefault enablePan enableZoom enableDamping dampingFactor={0.12} />
    </Canvas>
  );
}
