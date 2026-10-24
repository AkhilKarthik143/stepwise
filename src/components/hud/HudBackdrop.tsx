// Soft aurora glow, faint grid and one slow ring. Decorative only.

export default function HudBackdrop({ rings = true }: { rings?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="absolute left-1/2 top-[-20%] h-[70vh] w-[110vw] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(56,160,230,0.32),transparent)] blur-2xl" />
      <div className="absolute right-[-10%] top-[30%] h-[50vh] w-[50vw] rounded-[50%] bg-[radial-gradient(closest-side,rgba(99,102,241,0.12),transparent)] blur-2xl" />
      <div className="hud-grid absolute inset-0" />
      {rings && (
        <svg className="absolute left-1/2 top-[14%] h-[1000px] w-[1000px] -translate-x-1/2 -translate-y-1/2 opacity-30" viewBox="0 0 1000 1000">
          <g className="spin-slow" style={{ transformBox: "fill-box" }}>
            <circle cx="500" cy="500" r="470" fill="none" stroke="rgba(148,210,255,0.5)" strokeWidth="1" strokeDasharray="1 14" />
          </g>
          <circle cx="500" cy="500" r="380" fill="none" stroke="rgba(148,210,255,0.12)" strokeWidth="1" />
        </svg>
      )}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-ink to-transparent" />
    </div>
  );
}
