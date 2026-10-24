/**
 * Hardware-agnostic capability tiers (Goal 3).
 *
 *  T0-hud   : no immersive AR — render a 2D HUD over the camera feed. Works on
 *             display glasses (XREAL Air / Rokid), phones, laptops. Voice-first.
 *  T1-3dof  : WebXR immersive-ar without world tracking — head-locked overlays.
 *  T2-6dof  : WebXR immersive-ar with hit-test / anchors / depth — world-locked
 *             markers stuck to real components (Quest 3 and similar).
 *
 * Detection is best-effort and refined when the AR session actually starts
 * (the granted optionalFeatures determine 3DoF vs 6DoF). One codebase, every
 * device — the 2D HUD is always the universal baseline.
 */
export type Tier = "T0-hud" | "T1-3dof" | "T2-6dof";

export interface Capabilities {
  tier: Tier;
  arSupported: boolean;
  details: string;
}

export async function detectCapabilities(): Promise<Capabilities> {
  const xr: any = (navigator as any).xr;
  if (!xr || typeof xr.isSessionSupported !== "function") {
    return { tier: "T0-hud", arSupported: false, details: "WebXR not present — 2D HUD." };
  }

  let arSupported = false;
  try {
    arSupported = await xr.isSessionSupported("immersive-ar");
  } catch {
    arSupported = false;
  }

  if (!arSupported) {
    return { tier: "T0-hud", arSupported: false, details: "Immersive AR unavailable — 2D HUD." };
  }

  // immersive-ar is supported. We optimistically target the richest tier; the
  // session-start negotiation (optionalFeatures) downgrades to 3DoF if the
  // device can't grant hit-test/anchors.
  return { tier: "T2-6dof", arSupported: true, details: "Immersive AR supported." };
}
