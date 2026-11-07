"use client";
import type { Slice } from "@/lib/finance";

/** Allocation ring built from SVG circles. The legend lives in the card so it can carry percentages. */
export function Donut({ slices, centerLabel, centerSub, size = 170 }: { slices: readonly Slice[]; centerLabel: string; centerSub?: string; size?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const stroke = size * 0.17;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const gap = slices.length > 1 ? 1.5 : 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${centerSub ?? "Total"} ${centerLabel}. ${slices.map((s) => `${s.label} ${total ? Math.round((s.value / total) * 100) : 0}%`).join(", ")}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {total > 0
          ? slices.map((s) => {
              const len = (s.value / total) * c;
              const dash = Math.max(0, len - gap);
              const el = (
                <circle
                  key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
                  strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
              );
              offset += len;
              return el;
            })
          : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="num text-[1.2rem] font-semibold leading-none tracking-tight">{centerLabel}</span>
        {centerSub ? <span className="mt-1 text-[0.7rem] leading-tight text-ink-3">{centerSub}</span> : null}
      </div>
    </div>
  );
}
