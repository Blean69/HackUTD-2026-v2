"use client";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { IconCap, IconCar, IconCard, IconClose, IconHome, IconPlane, IconPlus, IconTarget } from "@/components/icons";
import { Button, Card, Chip, Empty, IconTile, PageHeader, Progress, Skeleton, Spinner, inputCls, labelCls, selectCls, type Tone } from "@/components/ui";
import { ProposalList } from "@/components/voting/ProposalList";
import { deleteGoal, upsertGoal } from "@/lib/data/actions";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { useDataReady, useGoals } from "@/lib/data/hooks";
import { cx, longDate, usd } from "@/lib/format";
import { goalProgress } from "@/lib/finance";
import type { Feasibility, Goal, GoalPriority } from "@/lib/types";

const ICON_RULES: { re: RegExp; icon: (size: number) => ReactNode }[] = [
  { re: /home|house|roof|mortgage|down\s*payment/i, icon: (s) => <IconHome size={s} /> },
  { re: /\b(car|van|truck|vehicle|auto)\b/i, icon: (s) => <IconCar size={s} /> },
  { re: /trip|travel|vacation|hawaii|flight|holiday/i, icon: (s) => <IconPlane size={s} /> },
  { re: /college|education|school|tuition|529|degree/i, icon: (s) => <IconCap size={s} /> },
  { re: /card|visa|debt|loan|payoff|pay off/i, icon: (s) => <IconCard size={s} /> },
];
/** A tinted icon chosen by keyword in the goal title. */
function goalIcon(title: string, size: number): ReactNode {
  return (ICON_RULES.find((r) => r.re.test(title))?.icon ?? ((s: number) => <IconTarget size={s} />))(size);
}

const FEAS: Record<Exclude<Feasibility, "">, { tone: Tone; label: string; hint: string }> = {
  on_track: { tone: "good", label: "On track", hint: "Fits current cash and monthly surplus" },
  stretch: { tone: "watch", label: "Stretch", hint: "Possible with trade-offs or financing" },
  off_track: { tone: "risk", label: "Off track", hint: "Not reachable on today's numbers" },
};
const PRI: Record<GoalPriority, { label: string; tone: Tone }> = {
  high: { label: "High priority", tone: "brand" },
  medium: { label: "Medium priority", tone: "neutral" },
  low: { label: "Low priority", tone: "neutral" },
};

function GoalCard({ goal, saved }: { goal: Goal; saved: ReturnType<typeof goalProgress> }) {
  const f = goal.feasibility ? FEAS[goal.feasibility] : null;
  const pri = PRI[goal.priority];
  const [busy, setBusy] = useState(false);
  const target = goal.target_amount ?? 0;
  const tone: Tone = f?.tone === "risk" || f?.tone === "watch" ? f.tone : "brand";

  async function remove() {
    setBusy(true);
    try {
      await deleteGoal(goal.id);
    } catch {
      setBusy(false);
    }
  }

  return (
    <li>
      <Card className="flex h-full flex-col p-4">
        <div className="flex items-start gap-3">
          <IconTile tone={tone} size={40}>{goalIcon(goal.title, 20)}</IconTile>
          <div className="min-w-0 flex-1">
            <h3 className="text-[0.95rem] font-semibold leading-snug">{goal.title}</h3>
            <p className="num mt-0.5 text-[0.84rem] text-ink-2">
              {target ? <span className="font-semibold text-ink">{usd(target)}</span> : <span>No target amount</span>}
              {goal.target_date ? <> by {longDate(goal.target_date)}</> : null}
            </p>
          </div>
          <button
            type="button"
            aria-label={`Delete goal ${goal.title}`}
            title="Delete goal"
            disabled={busy}
            onClick={() => void remove()}
            className="-mr-1.5 -mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-risk disabled:opacity-50"
          >
            <IconClose size={16} />
          </button>
        </div>

        {saved ? (
          <div className="mt-3.5">
            <div className="flex items-baseline justify-between gap-2 text-[0.78rem]">
              <span className="num text-ink-2"><span className="font-semibold text-ink">{usd(saved.saved)}</span> of {usd(target)}</span>
              <span className="num font-semibold">{Math.round(saved.pct)}%</span>
            </div>
            <Progress value={saved.pct} tone={tone} label={`${goal.title} progress`} className="mt-1.5" />
            <p className="mt-1 text-[0.72rem] text-ink-3">{saved.basis === "account" ? "est. from your matching savings account" : "est. pace: time elapsed, adjusted for feasibility"}</p>
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {f ? <Chip tone={f.tone} title={f.hint}>{f.label}</Chip> : <Chip title="The agents are checking this against your accounts">Checking</Chip>}
          <Chip tone={pri.tone}>{pri.label}</Chip>
          {goal.source === "huddle" ? <Chip tone="info" title="Captured in a Table Mode session">From Table Mode</Chip> : null}
        </div>

        {goal.evidence_quote ? (
          <blockquote className="mt-3 border-l-2 border-line-strong pl-3 text-[0.82rem] italic leading-snug text-ink-2">&ldquo;{goal.evidence_quote}&rdquo;</blockquote>
        ) : null}
      </Card>
    </li>
  );
}

function AddGoalForm({ householdId, onDone }: { householdId: string; onDone: () => void }) {
  const uid = useId();
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [priority, setPriority] = useState<GoalPriority>("medium");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const clean = title.trim();
    if (!clean) return;
    const n = Number(amount);
    setBusy(true);
    setErr(null);
    try {
      await upsertGoal({
        household_id: householdId,
        title: clean,
        target_amount: amount && Number.isFinite(n) && n > 0 ? n : undefined,
        target_date: date || undefined,
        priority,
        source: "manual",
      });
      onDone();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Couldn't save the goal");
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4 p-4">
      <form onSubmit={(e) => void submit(e)} aria-label="Add a goal">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-title`} className={labelCls}>Goal</label>
            <input id={`${uid}-title`} className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Family trip to Hawaii" maxLength={80} required autoFocus />
          </div>
          <div>
            <label htmlFor={`${uid}-amount`} className={labelCls}>Target amount (USD)</label>
            <input id={`${uid}-amount`} className={inputCls} type="number" inputMode="decimal" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" />
          </div>
          <div>
            <label htmlFor={`${uid}-date`} className={labelCls}>Target date</label>
            <input id={`${uid}-date`} className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`${uid}-pri`} className={labelCls}>Priority</label>
            <select id={`${uid}-pri`} className={cx(selectCls, "h-10 w-full")} value={priority} onChange={(e) => setPriority(e.target.value as GoalPriority)}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>
        {err ? <p role="alert" className="mt-3 rounded-md bg-risk-soft px-3 py-2 text-[0.84rem] text-risk">{err}</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? <Spinner /> : null}
            Save goal
          </Button>
          <Button variant="ghost" onClick={onDone} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

export function GoalsPage({ householdId }: { householdId: string }) {
  const ready = useDataReady();
  const goals = useGoals(householdId);
  const fin = useRoomFinance(householdId);
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <PageHeader
        title="Goals"
        sub="What the household is saving toward, checked against real balances"
        right={
          <Button onClick={() => setAdding((a) => !a)} aria-expanded={adding} aria-controls="add-goal">
            {adding ? <IconClose size={16} /> : <IconPlus size={16} />}
            {adding ? "Close" : "Add goal"}
          </Button>
        }
      />

      <div id="add-goal">
        {adding ? <AddGoalForm householdId={householdId} onDone={() => setAdding(false)} /> : null}
      </div>

      {!ready ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading goals">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44 !rounded-lg" />)}
        </div>
      ) : goals.length ? (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Household goals">
          {goals.map((g) => <GoalCard key={g.id} goal={g} saved={goalProgress(g, fin.accounts, fin.today)} />)}
        </ul>
      ) : (
        <Empty title="No goals yet">Add one above, or run a Table Mode session and the agents will turn what you say into goals.</Empty>
      )}

      <div className="mt-8">
        <ProposalList householdId={householdId} />
      </div>
    </div>
  );
}
