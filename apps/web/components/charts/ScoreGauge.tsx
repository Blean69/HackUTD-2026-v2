import type { ReactNode } from "react";
import { cx as cls } from "@/lib/format";

type GaugeTone = "good" | "watch" | "risk" | "info" | "brand";
const STROKE: Record<GaugeTone, string> = { good: "var(--good)", watch: "var(--watch)", risk: "var(--risk)", info: "var(--info)", brand: "var(--brand)" };
const TEXT: Record<GaugeTone, string> = { good: "text-good", watch: "text-watch", risk: "text-risk", info: "text-info", brand: "text-brand-strong" };

export interface GaugeBand {
  /** Upper bound of the band (inclusive). The last band should reach `max`. */
  to: number;
  tone: GaugeTone;
  label: string;
}

const START = 150; // degrees, SVG coordinates (0 = 3 o'clock, clockwise): bottom-left
const SWEEP = 240; // through the top to bottom-right
const GAP = 2.2; // degrees of surface between band segments

function pt(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = pt(cx, cy, r, a0);
  const [x1, y1] = pt(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * A 240° arc gauge for a bounded score (household health 0-100, credit 300-850). The track is the bands, drawn soft with
 * 2° surface gaps; the solid arc runs from the start to the value in the colour of the band it lands in, ending in a dot
 * with a surface ring. The figure and the band's name sit in the middle, so colour is never the only signal.
 */
export function ScoreGauge({
  value, min, max, bands, label, size = 168, format = (n) => String(Math.round(n)), caption, showRange = true, className,
}: {
  value: number | null;
  min: number;
  max: number;
  bands: GaugeBand[];
  /** Accessible name, e.g. "Credit score". */
  label: string;
  size?: number;
  format?: (n: number) => string;
  /** Under the band name, e.g. "Simulated score". */
  caption?: ReactNode;
  showRange?: boolean;
  className?: string;
}) {
  const w = size;
  const sw = Math.max(8, Math.round(size * 0.07));
  const r = w / 2 - sw / 2 - 1;
  const cx = w / 2;
  const cy = w / 2;
  const h = Math.round(cy + r * Math.sin((30 * Math.PI) / 180) + sw / 2 + (showRange ? 14 : 2));
  const span = max - min || 1;
  const angle = (v: number) => START + (Math.max(0, Math.min(1, (v - min) / span)) * SWEEP);
  const v = value === null ? null : Math.max(min, Math.min(max, value));
  const band = v === null ? undefined : (bands.find((b) => v <= b.to) ?? bands[bands.length - 1]);

  const segments = bands.map((b, i) => {
    const from = i === 0 ? min : bands[i - 1].to;
    const a0 = angle(from) + (i === 0 ? 0 : GAP / 2);
    const a1 = angle(Math.min(b.to, max)) - (i === bands.length - 1 ? 0 : GAP / 2);
    return { key: `${b.to}`, d: arc(cx, cy, r, a0, Math.max(a0 + 0.1, a1)), tone: b.tone };
  });
  const end = v === null ? null : angle(v);
  const [dx, dy] = end === null ? [0, 0] : pt(cx, cy, r, end);
  const [lx, ly] = pt(cx, cy, r, START);
  const [rx, ry] = pt(cx, cy, r, START + SWEEP);

  return (
    <div className={cls("relative inline-block", className)} style={{ width: w, height: h }} role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={v ?? undefined} aria-valuetext={v === null ? "No score yet" : `${format(v)}, ${band?.label ?? ""}`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="overflow-visible">
        {segments.map((s) => (
          <path key={s.key} d={s.d} fill="none" stroke={STROKE[s.tone]} strokeOpacity={0.2} strokeWidth={sw} />
        ))}
        {end !== null && band ? (
          <>
            <path d={arc(cx, cy, r, START, Math.max(START + 0.1, end))} fill="none" stroke={STROKE[band.tone]} strokeWidth={sw} className="transition-[d] duration-700" />
            <circle cx={dx} cy={dy} r={sw / 2 + 2.5} fill="var(--surface)" />
            <circle cx={dx} cy={dy} r={sw / 2 - 0.5} fill={STROKE[band.tone]} />
          </>
        ) : null}
        {showRange ? (
          <>
            <text x={lx} y={ly + sw / 2 + 12} textAnchor="middle" fontSize={10} fill="var(--ink-3)" className="num">{format(min)}</text>
            <text x={rx} y={ry + sw / 2 + 12} textAnchor="middle" fontSize={10} fill="var(--ink-3)" className="num">{format(max)}</text>
          </>
        ) : null}
      </svg>
      <div className="absolute inset-x-0 flex flex-col items-center" style={{ top: cy - size * 0.2 }}>
        <span className="figure leading-none text-ink" style={{ fontSize: Math.round(size * 0.21) }}>{v === null ? "—" : format(v)}</span>
        {band ? <span className={cls("mt-1.5 text-caption font-semibold", TEXT[band.tone])}>{band.label}</span> : null}
        {caption ? <span className="mt-0.5 text-2xs text-ink-3">{caption}</span> : null}
      </div>
    </div>
  );
}

/** Credit-score bands from docs/contracts.md §9. */
export const CREDIT_BANDS: GaugeBand[] = [
  { to: 579, tone: "risk", label: "Poor" },
  { to: 669, tone: "watch", label: "Fair" },
  { to: 739, tone: "good", label: "Good" },
  { to: 799, tone: "good", label: "Very good" },
  { to: 850, tone: "good", label: "Exceptional" },
];
/** Household health (0-100). */
export const HEALTH_BANDS: GaugeBand[] = [
  { to: 49, tone: "risk", label: "At risk" },
  { to: 69, tone: "watch", label: "Needs attention" },
  { to: 100, tone: "good", label: "Healthy" },
];
