/**
 * Full-screen camera feed = the technician's view (T0 / non-immersive devices:
 * XREAL Air, phones, laptops). The r3f canvas, annotation overlay, and HUD layer
 * on top. In an immersive AR session the headset's own passthrough/see-through is
 * the real background instead, and this simply sits behind it.
 *
 * The stream is attached by useWebRTC (it sets srcObject on #camera-bg).
 */
export function CameraBackground() {
  return <video id="camera-bg" className="camera-bg" autoPlay muted playsInline />;
}
