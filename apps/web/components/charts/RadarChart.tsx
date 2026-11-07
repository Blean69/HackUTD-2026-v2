"use client";

/** Seven-axis health radar. Solid = this household, dashed = the 70-point "healthy" line. */
export function RadarChart({ axes, size = 240, threshold = 70 }: { axes: readonly { axis: string; score: number }[]; size?: number; threshold?: number }) {
  const n = axes.length;
  if (n < 3) return null;
  const w = size + 80;
  const cx = w / 2;
  const cy = size / 2 + 10;
  const R = size * 0.36;
  const pt = (i: number, frac: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * R * frac, cy + Math.sin(a) * R * frac] as const;
  };
  const poly = (f: (i: number) => number) => axes.map((_, i) => pt(i, f(i)).map((v) => v.toFixed(1)).join(",")).join(" ");
  const summary = axes.map((a) => `${a.axis} ${a.score}`).join(", ");
  return (
    <svg viewBox={`0 0 ${w} ${size + 20}`} className="mx-auto block h-auto w-full max-w-[340px]" role="img" aria-label={`Health radar. ${summary}`}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={poly(() => f)} fill="none" stroke="var(--line)" strokeWidth={1} />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, 1);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--line)" strokeWidth={1} />;
      })}
      <polygon points={poly(() => threshold / 100)} fill="none" stroke="var(--ink-3)" strokeWidth={1.2} strokeDasharray="4 3" />
      <polygon points={poly((i) => Math.max(0.04, axes[i].score / 100))} fill="var(--c2)" fillOpacity={0.22} stroke="var(--brand)" strokeWidth={2} strokeLinejoin="round" />
      {axes.map((a, i) => {
        const [x, y] = pt(i, Math.max(0.04, a.score / 100));
        return <circle key={a.axis} cx={x} cy={y} r={3} fill="var(--brand)" />;
      })}
      {axes.map((a, i) => {
        const [x, y] = pt(i, 1.2);
        const anchor = Math.abs(x - cx) < 6 ? "middle" : x > cx ? "start" : "end";
        return (
          <text key={a.axis} x={x} y={y} textAnchor={anchor} dominantBaseline="middle" fontSize={11} fill="var(--ink-2)">
            {a.axis}
          </text>
        );
      })}
    </svg>
  );
}
