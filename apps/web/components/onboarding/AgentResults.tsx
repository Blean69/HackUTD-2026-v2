"use client";
import Link from "next/link";
import { IconCheck, IconSpark } from "@/components/icons";
import { Chip, Spinner, StatusDot, type Tone } from "@/components/ui";
import { cx } from "@/lib/format";
import { useInsights, useInsightsRun, useOnboardingGoals } from "@/lib/data/onboarding";
import type { Feasibility } from "@/lib/types";

const FEAS: Record<Feasibility, { label: string; tone: Tone }> = {
  "": { label: "Checking…", tone: "neutral" },
  on_track: { label: "On track", tone: "good" },
  stretch: { label: "A stretch", tone: "watch" },
  off_track: { label: "Needs a plan", tone: "risk" },
};
const SEV: Record<string, "info" | "watch" | "risk"> = { info: "info", warn: "watch", critical: "risk" };
/** While the assistant works, show just its latest steps so the page stays calm; the full list opens after. */
const RECENT = 5;

/** What the assistant is doing (its trace, in plain words), the insights as they arrive, and the goal checks. */
export function AgentResults({ householdId, waiting }: { householdId: string; waiting?: boolean }) {
  const { run, events } = useInsightsRun(householdId);
  const insights = useInsights(householdId);
  const goals = useOnboardingGoals(householdId);
  const running = !run || run.status === "running";
  const failed = run?.status === "error";
  const steps = events.filter((e) => e.type !== "run_started");

  return (
    <div className="space-y-4">
      <section aria-labelledby="agent-h" className="rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-2.5">
          <span className={cx("flex h-8 w-8 items-center justify-center rounded-lg", failed ? "bg-risk-soft text-risk" : running ? "bg-brand-soft text-brand-strong" : "bg-good-soft text-good")}>
            {running && !failed ? <Spinner size={17} /> : <IconSpark size={17} />}
          </span>
          <div className="min-w-0">
            <h2 id="agent-h" className="text-[0.95rem] font-semibold leading-tight">
              {failed ? "The assistant hit a snag" : running ? "Your assistant is looking things over" : "Your assistant is done"}
            </h2>
            <p className="text-[0.78rem] text-ink-3">
              {failed ? "Your dashboard is ready. Insights can be refreshed there." : running ? "You can watch each step as it happens." : "Here is what it found."}
            </p>
          </div>
        </div>
        <details open={running} className="group mt-3">
          <summary className={cx("cursor-pointer list-none text-[0.8rem] font-medium text-brand-strong underline underline-offset-2", running && "hidden")}>
            <span className="group-open:hidden">Show the {steps.length} steps</span>
            <span className="hidden group-open:inline">Hide the steps</span>
          </summary>
          <ol className="mt-2 space-y-1.5" aria-live="polite" aria-label="Assistant steps">
            {steps.length === 0 ? (
              <li className="flex items-center gap-2 text-[0.85rem] text-ink-2">
                <Spinner size={14} /> {waiting ? "Waiting for your accounts to finish syncing…" : "Getting started…"}
              </li>
            ) : null}
            {steps.length > RECENT && running ? <li className="num text-[0.78rem] text-ink-3">{steps.length - RECENT} earlier steps done</li> : null}
            {(running ? steps.slice(-RECENT) : steps).map((e) => {
              const last = e === steps[steps.length - 1];
              const spinning = last && running && !failed;
              return (
                <li key={e.id} className="anim-fade flex items-start gap-2 text-[0.85rem] leading-snug">
                  <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center", e.type === "error" ? "text-risk" : spinning ? "text-brand" : "text-good")}>
                    {spinning ? <Spinner size={14} /> : <IconCheck size={14} strokeWidth={2.6} />}
                  </span>
                  <span className={cx("line-clamp-2 min-w-0", last ? "font-medium text-ink" : "text-ink-2")}>{e.title}</span>
                </li>
              );
            })}
          </ol>
        </details>
        <p className="mt-3 text-[0.76rem] text-ink-3">
          Curious how it works? <Link href="/agents" className="font-medium text-brand-strong underline underline-offset-2">See every step in the Agent trail</Link>
        </p>
      </section>

      {insights.length ? (
        <section aria-labelledby="insights-h">
          <h2 id="insights-h" className="mb-2 text-[0.95rem] font-semibold">
            First things we noticed
          </h2>
          <ul className="space-y-2">
            {insights.map((a) => (
              <li key={a.id} className="anim-fade flex gap-3 rounded-lg border border-line bg-surface p-3.5">
                <span className="mt-1.5"><StatusDot tone={SEV[a.severity] ?? "info"} /></span>
                <div className="min-w-0">
                  <p className="text-[0.9rem] font-semibold leading-snug">{a.title}</p>
                  {a.detail ? <p className="mt-0.5 text-[0.84rem] leading-relaxed text-ink-2">{a.detail}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {goals.length ? (
        <section aria-labelledby="goals-h">
          <h2 id="goals-h" className="mb-2 text-[0.95rem] font-semibold">
            Your goals
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {goals.map((g) => {
              const f = g.feasibility === "" && !running ? { label: "Add an amount to check", tone: "neutral" as Tone } : (FEAS[g.feasibility] ?? FEAS[""]);
              return (
                <li key={g.id} className="flex items-center justify-between gap-3 px-3.5 py-3">
                  <span className="min-w-0 text-[0.88rem] font-medium">{g.title}</span>
                  <Chip tone={f.tone}>{f.label}</Chip>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
