import { useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { createXRStore, XR } from "@react-three/xr";
import { Fullscreen, Container, Text } from "@react-three/uikit";
import type { Annotation, ConnState } from "../lib/useWebRTC";
import { WorldMarkers } from "./WorldMarkers";

// The XR store lives HERE, inside the lazily-loaded Scene chunk — NOT at App
// module scope. Importing createXRStore at the app entry would statically pull
// the whole three + r3f stack into the eager bundle and block first paint; by
// owning it behind the lazy boundary, the camera feed + 2D HUD paint first and
// this 3D stack streams in after. emulate is dev-only (a real headset never
// downloads the multi-MB emulator + synthetic room meshes).
const xrStore = createXRStore({ emulate: import.meta.env.DEV });

/** Imperative AR-entry handle handed up to the App once this chunk has mounted,
 *  so the "Enter AR" button can't fire before the XR manager exists. */
export interface SceneApi {
  enterAR: () => Promise<void>;
}

/** r3f Canvas + WebXR session + the in-AR spatial HUD (uikit, screen-space).
 *  On desktop the Canvas renders the same uikit panel as a 2D overlay; in AR it
 *  becomes a head-locked HUD. World-anchored component markers mount inside <XR>
 *  alongside it and only activate when an immersive session is running. */
export function Scene({
  status,
  annotations,
  onReady,
}: {
  status: ConnState;
  annotations: Annotation[];
  onReady?: (api: SceneApi) => void;
}) {
  // Signal readiness AFTER mount, so enterAR() is only offered once <XR> has set
  // the WebXR manager on the store (otherwise enterAR rejects with "canvas not
  // loaded?"). enterAR resolves/rejects from the real WebXR requestSession.
  useEffect(() => {
    onReady?.({
      enterAR: async () => {
        await xrStore.enterAR();
      },
    });
  }, [onReady]);

  return (
    <Canvas
      style={{ position: "fixed", inset: 0, zIndex: 1 }}
      gl={{ alpha: true, antialias: true }}
      camera={{ position: [0, 0, 1] }}
    >
      <ambientLight intensity={1.2} />
      <XR store={xrStore}>
        {/* 6DoF world-locked component markers (no-op outside an AR session). */}
        <WorldMarkers annotations={annotations} />

        <Fullscreen
          flexDirection="column"
          justifyContent="flex-end"
          alignItems="flex-start"
          padding={28}
          pointerEvents="none"
        >
          <Container
            backgroundColor="#0b0f14"
            borderRadius={18}
            borderWidth={1}
            borderColor="#19c37d"
            opacity={0.92}
            padding={16}
            flexDirection="column"
            gap={6}
          >
            <Text fontSize={18} fontWeight="bold" color="#19c37d">
              AR Technician Assistant
            </Text>
            <Text fontSize={14} color="#f5f7fa">
              {statusLabel(status)}
            </Text>
          </Container>
        </Fullscreen>
      </XR>
    </Canvas>
  );
}

function statusLabel(s: ConnState): string {
  switch (s) {
    case "connected":
      return "Connected — assistant is listening";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return "Disconnected";
    default:
      return "Tap Connect to begin";
  }
}
