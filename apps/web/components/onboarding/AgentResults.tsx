"use client";
import { IconAlert, IconCheck } from "@/components/icons";
import { Chip, Skeleton, type Tone } from "@/components/ui";
import { cx } from "@/lib/format";
import { useRoomTables } from "@/lib/data/hooks";
import { useInsights, useInsightsRun, useOnboardingGoals } from "@/lib/data/onboarding";
import type { Feasibility } from "@/lib/types";

const FEAS: Record<Feasibility, { label: string; tone: Tone }> = {
  "": { label: "Checking", tone: "neutral" },
  on_track: { label: "On track", tone: "good" },
  stretch: { label: "A stretch", tone: "watch" },
  off_track: { label: "Needs a plan", tone: "risk" },
  needs_details: { label: "Needs an amount", tone: "neutral" },
  not_advised: { label: "Not advised", tone: "risk" },
};
const DOT: Record<string, string> = { info: "bg-info", warn: "bg-watch", critical: "bg-risk" };
/** While the agents work, only their latest steps show, so the page stays calm. */
const RECENT = 4;

/**
 * The agents' first pass, as it happens: their latest steps (from the trace), then the insights and goal checks
 * sliding in as each one is written.
 */
export function AgentResults({ householdId, waiting }: { householdId: string; waiting?: boolean }) {
  const { run, events } = useInsightsRun(householdId);
  // The steps of this run only (trace_event is not in the room's base tables), plus the goals the run checks.
  useRoomTables(householdId, run ? [`trace_event@${run.run_id}`, "goal"] : ["goal"]);
  const insights = useInsights(householdId);
  const goals = useOnboardingGoals(householdId);
  const running = !run || run.status === "running";
  const failed = run?.status === "error";
  const steps = events.filter((e) => e.type !== "run_started");
  const shown = steps.slice(-RECENT);

  return (
    <div className="space-y-6">
      <section aria-labelledby="agent-h">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="agent-h" className="text-lead font-semibold">
            {failed ? "The agents hit a snag" : running ? "Your agents are at work" : "Your agents are done"}
          </h2>
          {steps.length ? <span className="num text-caption text-ink-3">{steps.length} steps</span> : null}
        </div>
        <ol className="mt-2.5 space-y-2" aria-live="polite" aria-label="Agent steps">
          {steps.length === 0 ? (
            <li className="flex items-center gap-2.5 text-body text-ink-2">
              <span className="anim-blink h-2 w-2 shrink-0 rounded-full bg-brand" aria-hidden="true" />
              {waiting ? "Waiting for the import to finish, so nothing is missed" : "Starting up"}
            </li>
          ) : null}
          {shown.map((e) => {
            const last = e === steps[steps.length - 1];
            const active = last && running && !failed;
            return (
              <li key={e.id} className="motion-fade flex items-start gap-2.5 text-body leading-snug">
                <span className="mt-[0.2rem] flex h-4 w-4 shrink-0 items-center justify-center">
                  {e.type === "error" ? (
                    <IconAlert size={14} className="text-risk" />
                  ) : active ? (
                    <span className="anim-blink h-2 w-2 rounded-full bg-brand" aria-hidden="true" />
                  ) : (
                    <IconCheck size={14} strokeWidth={2.6} className="text-good" />
                  )}
                </span>
                <span className={cx("line-clamp-2 min-w-0", active ? "font-medium text-ink" : "text-ink-2")}>{e.title}</span>
              </li>
            );
          })}
        </ol>
        {failed ? <p className="mt-2 text-label text-ink-2">Your dashboard is ready, and insights can be refreshed from there.</p> : null}
      </section>

      <section aria-labelledby="insights-h">
        <h2 id="insights-h" className="text-lead font-semibold">
          First insights
        </h2>
        <ul className="mt-2.5 space-y-2" aria-live="polite">
          {insights.map((a) => (
            <li key={a.id} className="motion-rise flex gap-3 rounded-lg border border-line px-4 py-3">
              <span className={cx("mt-[0.45rem] h-2 w-2 shrink-0 rounded-full", DOT[a.severity] ?? "bg-info")} aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-lead font-semibold leading-snug">{a.title}</p>
                {a.detail ? <p className="mt-0.5 line-clamp-3 text-body leading-relaxed text-ink-2">{a.detail}</p> : null}
              </div>
            </li>
          ))}
          {running && !failed ? (
            <li aria-hidden="true" className="rounded-lg border border-dashed border-line px-4 py-3.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="mt-2 h-3 w-11/12" />
            </li>
          ) : null}
          {!running && insights.length === 0 ? <li className="text-body text-ink-2">No insights yet. They will appear on your dashboard.</li> : null}
        </ul>
      </section>

      {goals.length ? (
        <section aria-labelledby="goals-h">
          <h2 id="goals-h" className="text-lead font-semibold">
            Your goals
          </h2>
          <ul className="mt-2.5 divide-y divide-line rounded-lg border border-line">
            {goals.map((g, i) => {
              const f = g.feasibility === "" && !running ? { label: "Add an amount to check", tone: "neutral" as Tone } : (FEAS[g.feasibility] ?? FEAS[""]);
              return (
                <li key={g.id} className="motion-fade flex items-center justify-between gap-3 px-4 py-3" style={{ ["--i" as string]: i }}>
                  <span className="min-w-0 text-body font-medium">{g.title}</span>
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
