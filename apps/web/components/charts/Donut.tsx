"use client";
import { useEffect, useState, type ReactNode } from "react";

export interface DonutSlice { key: string; value: number; color: string; label: string }

/**
 * Animated donut: slices sweep in on mount. Hover, focus or tap a slice (or pass `active` from a legend) to lift it, dim the rest
 * and, when `format` is given, show that slice's value and share in the hole instead of `children`.
 */
export function Donut({
  slices, total, size = 120, thickness = 14, children, label, format, active: activeProp, onActive,
}: {
  slices: DonutSlice[]; total?: number; size?: number; thickness?: number; children?: ReactNode; label: string;
  format?: (n: number) => string; active?: string | null; onActive?: (key: string | null) => void;
}) {
  const [on, setOn] = useState(false);
  const [own, setOwn] = useState<string | null>(null);
  useEffect(() => { const r = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(r); }, []);
  const active = activeProp !== undefined ? activeProp : own;
  const set = (k: string | null) => { setOwn(k); onActive?.(k); };
  const sum = total ?? (slices.reduce((s, x) => s + x.value, 0) || 1);
  const r = (size - thickness - 6) / 2;
  const c = 2 * Math.PI * r;
  const lens = slices.map((s) => Math.max(0, Math.min(1, s.value / sum)) * c);
  const starts = lens.map((_, i) => lens.slice(0, i).reduce((a, x) => a + x, 0));
  const hit = slices.find((s) => s.key === active);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="group" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" onPointerLeave={() => set(null)}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
        {slices.map((s, i) => {
          const gap = slices.length > 1 ? 2 : 0;
          const isOn = s.key === active;
          return (
            <circle
              key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeLinecap="butt"
              strokeWidth={isOn ? thickness + 6 : thickness}
              strokeDasharray={`${on ? Math.max(0, lens[i] - gap) : 0} ${c}`} strokeDashoffset={-starts[i]}
              opacity={active && !isOn ? 0.3 : 1}
              tabIndex={0} role="img" aria-label={`${s.label}: ${Math.round((s.value / sum) * 100)}%`}
              className="cursor-pointer outline-none"
              style={{ transition: `stroke-dasharray 900ms var(--ease-out) ${i * 90}ms, stroke-width 160ms var(--ease-out), opacity 160ms` }}
              onPointerEnter={() => set(s.key)} onFocus={() => set(s.key)} onBlur={() => set(null)}
              onClick={() => set(isOn ? null : s.key)}
            />
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-3 text-center">
        {hit && format ? (
          <>
            <span className="figure text-lead">{format(hit.value)}</span>
            <span className="max-w-full truncate text-caption text-ink-3">{hit.label} · {Math.round((hit.value / sum) * 100)}%</span>
          </>
        ) : children}
      </div>
    </div>
  );
}
