"use client";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { IconCap, IconCar, IconCard, IconClose, IconHome, IconPlane, IconPlus, IconTarget } from "@/components/icons";
import { Button, Card, Chip, Empty, ErrorNote, IconTile, PageHeader, Progress, Skeleton, Spinner, inputCls, labelCls, selectCls, type Tone } from "@/components/ui";
import { ProposalList } from "@/components/voting/ProposalList";
import { deleteGoal, upsertGoal } from "@/lib/data/actions";
import { useToday } from "@/lib/data/finance-hooks";
import { useAccounts, useGoals, useRoomTables } from "@/lib/data/hooks";
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
  needs_details: { tone: "neutral", label: "Needs an amount", hint: "No amount was mentioned yet, so there is nothing to check. Add one on the Goals page." },
  not_advised: { tone: "risk", label: "Not advised", hint: "Gambling or speculation: not something we score as a plan." },
};
function GoalCard({ goal, saved }: { goal: Goal; saved: ReturnType<typeof goalProgress> }) {
  const f = goal.feasibility ? FEAS[goal.feasibility] : null;
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
          <IconTile tone={tone} size={36}>{goalIcon(goal.title, 18)}</IconTile>
          <div className="min-w-0 flex-1">
            <h3 className="text-lead font-semibold leading-snug">{goal.title}</h3>
            <p className="num mt-0.5 text-label text-ink-2">
              {target ? <span className="font-semibold text-ink">{usd(target)}</span> : <span className="text-ink-3">No target amount</span>}
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
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2 text-label">
              <span className="num text-ink-2"><span className="font-semibold text-ink">{usd(saved.saved)}</span> of {usd(target)}</span>
              <span className="num font-semibold">{Math.round(saved.pct)}%</span>
            </div>
            <Progress value={saved.pct} tone={tone} label={`${goal.title} progress`} className="mt-1.5" />
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          {f ? <Chip tone={f.tone} title={f.hint}>{f.label}</Chip> : <Chip title="The agents are checking this against your accounts">Checking</Chip>}
          {goal.priority === "high" ? <span className="text-caption font-medium text-ink-2">High priority</span> : null}
        </div>

        {goal.evidence_quote ? (
          <blockquote className="mt-3 line-clamp-2 border-l-2 border-line-strong pl-3 text-label italic leading-snug text-ink-2">&ldquo;{goal.evidence_quote}&rdquo;</blockquote>
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
        {err ? <ErrorNote className="mt-3">{err}</ErrorNote> : null}
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

const SHOWN = 6;

export function GoalsPage({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["goal"]);
  const goals = useGoals(householdId);
  const accounts = useAccounts(householdId);
  const today = useToday();
  const [adding, setAdding] = useState(false);
  const [all, setAll] = useState(false);
  const shown = useMemo(() => (all ? goals : goals.slice(0, SHOWN)), [all, goals]);
  const summary = useMemo(() => {
    const n = { on_track: 0, stretch: 0, off_track: 0, needs_details: 0, not_advised: 0, "": 0 };
    for (const g of goals) n[g.feasibility || ""] += 1;
    const parts = [n.on_track && `${n.on_track} on track`, n.stretch && `${n.stretch} a stretch`, n.off_track && `${n.off_track} off track`, n.not_advised && `${n.not_advised} not advised`, n.needs_details && `${n.needs_details} needing an amount`, n[""] && `${n[""]} being checked`].filter(Boolean);
    return `${goals.length} ${goals.length === 1 ? "goal" : "goals"}, checked against your real balances${parts.length ? `: ${parts.join(", ")}` : ""}.`;
  }, [goals]);

  return (
    <div>
      <PageHeader
        title="Goals"
        sub={ready && goals.length ? <span className="num">{summary}</span> : "Checked against your real balances."}
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
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 !rounded-lg" />)}
        </div>
      ) : goals.length ? (
        <>
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Household goals">
            {shown.map((g) => <GoalCard key={g.id} goal={g} saved={goalProgress(g, accounts, today)} />)}
          </ul>
          {goals.length > SHOWN ? (
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${goals.length} goals`}</Button>
            </div>
          ) : null}
          <p className="mt-3 text-caption text-ink-3">Progress is estimated from a matching savings account, or from the goal&apos;s timeline.</p>
        </>
      ) : (
        <Empty title="No goals yet">Add one, or run Table Mode and the agents will turn what you say into goals.</Empty>
      )}

      <div className="mt-8">
        <ProposalList householdId={householdId} />
      </div>
    </div>
  );
}
