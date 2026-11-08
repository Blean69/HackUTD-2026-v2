import { BANDS, type CreditHistoryPoint } from "@/lib/finance-credit";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });
const DAYFMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const parse = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`);

const W = 320;
const H = 132;
const PAD = { l: 30, r: 12, t: 12, b: 22 };

/** One month label per point, skipping a repeat month or one that would collide with the label before it. The last point always gets one. */
function labels(points: readonly CreditHistoryPoint[], x: (d: string) => number) {
  const out: { date: string; x: number; text: string; anchor: "start" | "middle" | "end" }[] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    const text = i === points.length - 1 ? DAYFMT.format(parse(p.date)) : MONTH.format(parse(p.date));
    const px = x(p.date);
    const prev = out[out.length - 1];
    if (prev && (prev.text.startsWith(text) || prev.x - px < (prev.anchor === "end" ? 44 : 26))) continue;
    out.push({ date: p.date, x: px, text, anchor: i === points.length - 1 ? "end" : i === 0 ? "start" : "middle" });
  }
  return out;
}

/**
 * Score over the last months: one line, a dot per point, the latest point labelled, and the band thresholds that
 * fall inside the range as faint guides. Plain SVG (no chart library), so the page stays light.
 */
export function CreditTrend({ points, className }: { points: readonly CreditHistoryPoint[]; className?: string }) {
  if (points.length < 2) {
    return <p className="text-label text-ink-3">The trend appears after the first monthly update.</p>;
  }
  const scores = points.map((p) => p.score);
  let lo = Math.min(...scores);
  let hi = Math.max(...scores);
  const pad = Math.max(12, (hi - lo) * 0.25);
  lo = Math.max(300, Math.floor((lo - pad) / 10) * 10);
  hi = Math.min(850, Math.ceil((hi + pad) / 10) * 10);
  const t0 = parse(points[0].date).getTime();
  const t1 = parse(points[points.length - 1].date).getTime();
  const x = (d: string) => PAD.l + ((parse(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (s: number) => PAD.t + (1 - (s - lo) / Math.max(1, hi - lo)) * (H - PAD.t - PAD.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)} ${y(p.score).toFixed(1)}`).join(" ");
  const guides = BANDS.slice(1).map((b) => ({ v: b.min, label: b.label })).filter((g) => g.v > lo && g.v < hi);
  const last = points[points.length - 1];
  const first = points[0];
  const summary = `Score went from ${first.score} on ${DAYFMT.format(parse(first.date))} to ${last.score} on ${DAYFMT.format(parse(last.date))}.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-label={summary}>
      {[lo, hi].map((v) => (
        <text key={v} x={PAD.l - 6} y={y(v) + 3} textAnchor="end" className="num" style={{ fontSize: 9, fill: "var(--ink-3)" }}>{v}</text>
      ))}
      <line x1={PAD.l} x2={W - PAD.r} y1={y(lo)} y2={y(lo)} stroke="var(--line-strong)" strokeWidth={1} />
      {guides.map((g) => (
        <g key={g.v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(g.v)} y2={y(g.v)} stroke="var(--line)" strokeDasharray="3 3" />
          <text x={W - PAD.r} y={y(g.v) - 3} textAnchor="end" style={{ fontSize: 8.5, fill: "var(--ink-3)" }}>{g.label} {g.v}</text>
        </g>
      ))}
      <path d={line} fill="none" stroke="var(--brand)" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={p.date} cx={x(p.date)} cy={y(p.score)} r={i === points.length - 1 ? 4 : 2.6} fill={i === points.length - 1 ? "var(--brand)" : "var(--surface)"} stroke="var(--brand)" strokeWidth={1.6} />
      ))}
      <text x={x(last.date) - 6} y={y(last.score) - 8} textAnchor="end" className="num" style={{ fontSize: 10.5, fontWeight: 650, fill: "var(--ink)" }}>{last.score}</text>
      {labels(points, x).map((l) => (
        <text key={`m${l.date}`} x={l.x} y={H - 6} textAnchor={l.anchor} style={{ fontSize: 9, fill: "var(--ink-3)" }}>{l.text}</text>
      ))}
    </svg>
  );
}
