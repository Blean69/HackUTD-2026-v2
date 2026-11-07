"use client";

const COLOR = { brand: "var(--brand)", good: "var(--good)", watch: "var(--watch)", risk: "var(--risk)" } as const;

/** A single-value ring ("26% debt-to-income") with the value in the middle. */
export function RingGauge({ value, max = 100, label, sub, tone = "brand", size = 120 }: { value: number; max?: number; label: string; sub?: string; tone?: keyof typeof COLOR; size?: number }) {
  const stroke = Math.max(8, size * 0.1);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, value / max));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${label}${sub ? ` ${sub}` : ""}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={COLOR[tone]} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="num text-[1.35rem] font-semibold leading-none tracking-tight">{label}</span>
        {sub ? <span className="mt-1 max-w-[70%] text-[0.66rem] leading-tight text-ink-3">{sub}</span> : null}
      </div>
    </div>
  );
}
