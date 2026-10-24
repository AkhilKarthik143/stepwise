import { createRoot } from "react-dom/client";
import ModelViewer3D from "../components/ModelViewer3D";
import type { ModelSpec } from "../lib/solutionModel";
import "../styles.css";

/**
 * DEV-ONLY visual harness (not in the production build): renders the 3D viewer
 * with a spec that references the bundled sample GLTF (web/public/sample-assets/
 * box.glb) plus a couple of primitive overlay parts, so the pre-built-model path
 * — load, auto-frame, and call-out overlay — can be screenshotted in a real
 * browser. Open /gltf-harness.html under `npm run dev`.
 */
// ?asset=<url> overrides the model (use a bad url to exercise the error-boundary
// fallback, or ?asset=none for primitives-only). Defaults to the bundled sample.
const assetParam = new URLSearchParams(location.search).get("asset");
const assetUrl = assetParam ?? "/static/sample-assets/box.glb";

const spec: ModelSpec = {
  mode: "3d",
  title: "GLTF harness",
  caption: "",
  emphasis: [],
  activeStep: 0,
  ...(assetUrl && assetUrl !== "none" ? { asset: { url: assetUrl, title: "Sample Box" } } : {}),
  parts: [
    {
      shape: "arrow",
      position: [0, 1.4, 0],
      size: [0.5, 1, 0.5],
      rotation: [0, 0, 0],
      color: "accent",
      label: "inlet",
      note: "fuel enters here",
      spec: [{ label: "Torque", value: "25 Nm" }],
    },
    {
      shape: "sphere",
      position: [1, 0, 0],
      size: [0.4, 0.4, 0.4],
      rotation: [0, 0, 0],
      color: "danger",
      label: "sensor",
      warning: "Hot surface — let cool",
    },
  ],
};

createRoot(document.getElementById("root")!).render(
  <div style={{ width: "100vw", height: "100vh", background: "#0b0e12" }}>
    <ModelViewer3D spec={spec} />
  </div>,
);
