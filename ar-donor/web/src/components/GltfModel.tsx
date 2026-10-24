import { useEffect } from "react";
import { useGLTF } from "@react-three/drei";
import { resolveAssetUrl } from "../lib/assetUrl";

/**
 * Loads and renders a pre-built GLTF/GLB model by URL (an operator-supplied
 * asset). Lazily imported by ModelViewer3D so the GLTFLoader only ships when a
 * diagram actually references an asset — the primitive-only path never pays for
 * it. `useDraco=false` keeps it to uncompressed glTF and avoids drei's default
 * Draco decoder fetched from a Google CDN, honouring the same-origin/offline
 * contract. Suspends while loading; a load failure throws to the parent error
 * boundary, which falls back to the primitive diagram so a bad/missing asset
 * never breaks the view. `onReady` fires once the scene is mounted so the parent
 * can re-frame the camera to include it.
 */
export default function GltfModel({ url, onReady }: { url: string; onReady?: () => void }) {
  // Resolve against the deploy base so a bare-relative catalog URL loads whether
  // the app is served at "/" (Vercel) or "/static/" (FastAPI). Absolute/CDN and
  // explicit root-absolute URLs pass through unchanged.
  const { scene } = useGLTF(resolveAssetUrl(url), false);
  useEffect(() => {
    onReady?.();
  }, [scene, onReady]);
  return <primitive object={scene} />;
}
