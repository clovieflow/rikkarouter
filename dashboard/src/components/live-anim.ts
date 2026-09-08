// ── live-anim: shared delta-driven motion helpers (FELiveAnim) ──
// Every animation in the dashboard fires ONLY from real data deltas between
// polls: count-ups tween toward the newest polled value, flashes mark rows /
// nodes whose numbers actually moved. No timers invent motion on their own.
// Durations follow §42 (160 micro / 300 panel / 500 major); glow is never
// added here (≤0.18 budget stays untouched).

/** True when the user asked for reduced motion — all tweens jump instantly. */
export function isReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** rAF count-up from `from` to `to` with cubic ease-out. Returns a cancel fn. */
export function tweenNumber(
  from: number,
  to: number,
  onUpdate: (v: number) => void,
  dur = 500,
): () => void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to || dur <= 0 || isReducedMotion()) {
    onUpdate(to);
    return () => {};
  }
  let raf = 0;
  const t0 = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    onUpdate(from + (to - from) * e);
    if (t < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/** Core-beat intensity 0..1 derived from real request rate (req/min, last 60s). */
export function beatOf(rps: number): number {
  return rps > 0 ? Math.min(1, rps / 20) : 0;
}
