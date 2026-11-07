"use client";
import { IconClose } from "@/components/icons";
import { Chip, SectionTitle, type Tone } from "@/components/ui";
import { deleteGoal } from "@/lib/data/actions";
import { cx, longDate, usd } from "@/lib/format";
import type { Feasibility, Goal } from "@/lib/types";

const FEAS: Record<Exclude<Feasibility, "">, { tone: Tone; label: string; hint: string }> = {
  on_track: { tone: "good", label: "On track", hint: "Fits your current cash and surplus" },
  stretch: { tone: "watch", label: "Stretch", hint: "Possible with trade-offs or financing" },
  off_track: { tone: "risk", label: "Off track", hint: "Not reachable on today's numbers" },
};
const PRI: Record<Goal["priority"], string> = { high: "High priority", medium: "Medium", low: "Low" };

export function GoalCards({ goals, since }: { goals: readonly Goal[]; since?: string }) {
  return (
    <section aria-labelledby="goals-h">
      <SectionTitle id="goals-h" title="Family goals" sub={goals.length ? "Checked against your real balances by the agents." : "Run a Huddle and the agents will turn it into goals."} />
      {goals.length ? (
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {goals.map((g) => {
            const f = g.feasibility ? FEAS[g.feasibility] : null;
            const fresh = !!since && g.source === "huddle" && g.created_at >= since;
            return (
              <li key={g.id} className={cx("anim-fade relative rounded-2xl border bg-surface p-4 shadow-card", fresh ? "border-brand" : "border-line")}>
                <button type="button" onClick={() => void deleteGoal(g.id)} aria-label={`Remove goal ${g.title}`} className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink">
                  <IconClose size={15} />
                </button>
                <div className="flex flex-wrap items-center gap-1.5 pr-8">
                  {fresh ? <Chip tone="brand">New from Huddle</Chip> : null}
                  {f ? <Chip tone={f.tone} title={f.hint}>{f.label}</Chip> : <Chip>Checking…</Chip>}
                  <Chip>{PRI[g.priority]}</Chip>
                </div>
                <h3 className="mt-2 font-display text-[1.05rem] font-semibold leading-snug">{g.title}</h3>
                <p className="num mt-0.5 text-sm text-ink-2">
                  {g.target_amount ? <span className="font-semibold text-ink">{usd(g.target_amount)}</span> : null}
                  {g.target_amount && g.target_date ? " by " : null}
                  {g.target_date ? longDate(g.target_date) : null}
                </p>
                {g.evidence_quote ? (
                  <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-[0.82rem] italic leading-snug text-ink-2">“{g.evidence_quote}”</blockquote>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
