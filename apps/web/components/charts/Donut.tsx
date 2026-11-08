"use client";
import { useEffect, useState, type ReactNode } from "react";

export interface DonutSlice { key: string; value: number; color: string; label: string }

/** Animated donut: slices sweep in on mount (stroke-dasharray transition). `children` sits in the hole. Also serves as a single-value ring. */
export function Donut({ slices, total, size = 120, thickness = 14, children, label }: { slices: DonutSlice[]; total?: number; size?: number; thickness?: number; children?: ReactNode; label: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(r); }, []);
  const sum = total ?? (slices.reduce((s, x) => s + x.value, 0) || 1);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((a, x) => a + Math.max(0, Math.min(1, x.value / sum)) * c, 0));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
        {slices.map((s, i) => {
          const len = Math.max(0, Math.min(1, s.value / sum)) * c;
          const gap = slices.length > 1 ? 2 : 0;
          return (
            <circle
              key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeLinecap="butt"
              strokeDasharray={`${on ? Math.max(0, len - gap) : 0} ${c}`} strokeDashoffset={-starts[i]}
              style={{ transition: `stroke-dasharray 900ms var(--ease-out) ${i * 90}ms` }}
            >
              <title>{`${s.label}: ${Math.round((s.value / sum) * 100)}%`}</title>
            </circle>
          );
        })}
      </svg>
      {children ? <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div> : null}
    </div>
  );
}
