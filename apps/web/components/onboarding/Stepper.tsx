"use client";
import { IconCheck } from "@/components/icons";
import { cx } from "@/lib/format";
import { STEPS } from "@/lib/data/onboarding";

/** Progress across the six steps: a compact bar on phones, a labelled stepper from the sm breakpoint up. */
export function Stepper({ current }: { current: number }) {
  const label = STEPS[current]?.label ?? "";
  return (
    <nav aria-label="Setup progress">
      {/* phones */}
      <div className="sm:hidden">
        <div className="flex items-baseline justify-between">
          <p className="text-[0.8rem] font-semibold text-ink">
            Step {current + 1} of {STEPS.length}
          </p>
          <p className="text-[0.8rem] text-ink-2" aria-current="step">
            {label}
          </p>
        </div>
        <ol className="mt-2 flex gap-1" aria-hidden="true">
          {STEPS.map((s, i) => (
            <li key={s.key} className={cx("h-1.5 flex-1 rounded-full", i < current ? "bg-brand" : i === current ? "bg-brand-strong" : "bg-line-strong")} />
          ))}
        </ol>
      </div>

      {/* tablets and up */}
      <ol className="hidden items-start sm:flex">
        {STEPS.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s.key} className="relative flex flex-1 flex-col items-center gap-1.5 text-center" aria-current={active ? "step" : undefined}>
              {i > 0 ? <span aria-hidden="true" className={cx("absolute right-1/2 top-[0.8rem] h-0.5 w-full", i <= current ? "bg-brand" : "bg-line-strong")} /> : null}
              <span
                className={cx(
                  "relative z-[1] inline-flex h-[1.65rem] w-[1.65rem] items-center justify-center rounded-full border-2 text-[0.75rem] font-semibold",
                  done ? "border-brand bg-brand text-white" : active ? "border-brand-strong bg-surface text-brand-strong" : "border-line-strong bg-surface text-ink-3",
                )}
              >
                {done ? <IconCheck size={14} strokeWidth={2.6} /> : <span className="num">{i + 1}</span>}
                <span className="sr-only">{done ? " (done)" : active ? " (current)" : ""}</span>
              </span>
              <span className={cx("text-[0.76rem] leading-tight", active ? "font-semibold text-ink" : done ? "text-ink-2" : "text-ink-3")}>{s.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
