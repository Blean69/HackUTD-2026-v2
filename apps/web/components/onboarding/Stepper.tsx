"use client";
import { cx } from "@/lib/format";
import { STEPS } from "@/lib/data/onboarding";

/**
 * Progress across the six steps: "Step 3 of 6 · Connect your bank" over a segmented bar. The same on every screen
 * size, so it never reflows. `sub` (0 to 1) partly fills the current segment for steps with several screens.
 */
export function Stepper({ current, sub = 0 }: { current: number; sub?: number }) {
  const label = STEPS[current]?.label ?? "";
  return (
    <nav aria-label="Setup progress">
      <p className="flex items-baseline justify-between gap-3 text-[0.8rem]">
        <span className="font-medium text-ink-3">
          Step <span className="num">{current + 1}</span> of <span className="num">{STEPS.length}</span>
        </span>
        <span className="truncate font-semibold text-ink" aria-current="step">
          {label}
        </span>
      </p>
      <ol className="mt-2 flex gap-1" aria-hidden="true">
        {STEPS.map((s, i) => {
          const fill = i < current ? 1 : i === current ? Math.max(0.12, Math.min(1, sub)) : 0;
          return (
            <li key={s.key} className="h-1 flex-1 overflow-hidden rounded-full bg-line">
              <span className={cx("bar-fill block h-full rounded-full", i < current ? "bg-brand" : "bg-brand-strong")} style={{ transform: `scaleX(${fill})` }} />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
