"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { IconBot, IconCar, IconCheck, IconClose, IconHome, IconPlane, IconTag } from "@/components/icons";
import { Button, Chip, IconTile, Spinner, type Tone } from "@/components/ui";
import { castVote, closeProposal } from "@/lib/data/actions";
import { tallyVotes, useMyVote } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { daysLeft } from "@/lib/finance";
import { cx, metric, usd } from "@/lib/format";
import type { Proposal, Vote, VoteChoice } from "@/lib/types";
import { VoteBar } from "./VoteBar";

const VERDICT: Record<"fine" | "tight" | "risky", { tone: Tone; label: string }> = {
  fine: { tone: "good", label: "Affordable" },
  tight: { tone: "watch", label: "Tight" },
  risky: { tone: "risk", label: "Risky" },
};
const CHOICES: { value: VoteChoice; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "abstain", label: "Abstain" },
];

export function proposalTerms(p: Proposal): string {
  const d = p.details;
  const bits = [usd(p.amount)];
  if (typeof d.down_pct === "number") bits.push(`${d.down_pct}% down`);
  if (typeof d.term_months === "number" || typeof d.rate_pct === "number") {
    bits.push(`${typeof d.term_months === "number" ? `${d.term_months} mo` : ""}${typeof d.rate_pct === "number" ? ` @ ${d.rate_pct}%` : ""}`.trim());
  }
  return bits.join(" · ");
}

function ProposalIcon({ title, size }: { title: string; size: number }) {
  if (/car|van|vehicle|truck|suv|honda|toyota|crv|cr-v/i.test(title)) return <IconCar size={size} />;
  if (/trip|travel|vacation|flight|visit/i.test(title)) return <IconPlane size={size} />;
  if (/home|house|roof|shower|bath|kitchen|oven|cooler|repair|furnace|hvac/i.test(title)) return <IconHome size={size} />;
  return <IconTag size={size} />;
}

export function isOpen(p: Proposal, now = Date.now()): boolean {
  return p.status === "open" && new Date(p.closes_at).getTime() > now;
}

export function whenText(p: Proposal): string {
  if (!isOpen(p)) return "Voting closed";
  const d = daysLeft(p.closes_at);
  return d <= 0 ? "Closes today" : d === 1 ? "1 day left" : `${d} days left`;
}

/** The agent's affordability verdict, summary and a link to its run in Agent Trail. */
export function Verdict({ p, showSummary = true }: { p: Proposal; showSummary?: boolean }) {
  const v = p.verdict ? VERDICT[p.verdict] : null;
  const summary = p.analysis?.summary ?? p.analysis?.headline;
  const waiting = !v && isOpen(p);
  return (
    <div className="rounded-md border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {v ? <Chip tone={v.tone}>{v.label}</Chip> : waiting ? <Chip tone="brand"><Spinner size={11} /> Checking affordability</Chip> : <Chip>No verdict</Chip>}
        {p.run_id ? (
          <Link href={`/agents?run=${encodeURIComponent(p.run_id)}`} className="inline-flex items-center gap-1 rounded-md border border-transparent bg-brand-soft px-1.5 py-0.5 text-[0.72rem] font-medium leading-4 text-brand-strong hover:underline" title="Open this agent run in Agent Trail">
            <IconBot size={12} /> Agent analysis
          </Link>
        ) : v ? (
          <Chip title="A quick estimate from your balances, not a full agent run">Quick estimate</Chip>
        ) : null}
      </div>
      {showSummary && summary ? <p className="mt-1.5 text-[0.8rem] leading-snug text-ink-2">{summary}</p> : null}
      {showSummary && p.analysis?.suggestion ? <p className="mt-1 text-[0.8rem] leading-snug text-ink-2"><span className="font-medium text-ink">Suggestion:</span> {p.analysis.suggestion}</p> : null}
    </div>
  );
}

/**
 * One proposal. `compact` is the dashboard card layout (single row on desktop); the full layout also shows the agent
 * metrics and who voted what.
 */
export function ProposalCard({ proposal: p, votes, eligible, compact }: { proposal: Proposal; votes: readonly Vote[]; eligible: number; compact?: boolean }) {
  const ident = useLocalIdentity();
  const mine = useMyVote(votes);
  const tally = useMemo(() => tallyVotes(votes), [votes]);
  const [busy, setBusy] = useState<VoteChoice | "close" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = isOpen(p);
  const name = ident.name ?? "Someone";

  async function vote(choice: VoteChoice) {
    setErr(null);
    setBusy(choice);
    try {
      await castVote(p.id, choice, name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't record your vote");
    } finally {
      setBusy(null);
    }
  }
  async function close() {
    setErr(null);
    setBusy("close");
    try {
      await closeProposal(p.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't close voting");
    } finally {
      setBusy(null);
    }
  }

  const outcome = !open ? (tally.yes > tally.no ? { tone: "good" as Tone, label: "Approved" } : tally.total ? { tone: "risk" as Tone, label: "Not approved" } : { tone: "neutral" as Tone, label: "No votes" }) : null;
  const metrics = !compact && p.analysis?.metrics?.length ? p.analysis.metrics : null;

  return (
    <article className="rounded-lg border border-line bg-surface p-3.5" aria-label={`Proposal: ${p.title}`}>
      <div className="flex items-start gap-3">
        <IconTile tone={open ? "brand" : "neutral"} size={compact ? 40 : 44}><ProposalIcon title={p.title} size={compact ? 20 : 22} /></IconTile>
        <div className="min-w-0 flex-1">
          <h3 className="text-[0.95rem] font-semibold leading-snug">{p.title}</h3>
          <p className="num mt-0.5 text-[0.8rem] text-ink-2">{proposalTerms(p)}</p>
          <p className="mt-0.5 text-[0.74rem] text-ink-3">Proposed by {p.created_by_name}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {open ? <Chip tone="good">Voting open</Chip> : outcome ? <Chip tone={outcome.tone}>{outcome.label}</Chip> : null}
          <span className="text-[0.74rem] text-ink-3">{whenText(p)}</span>
        </div>
      </div>

      <VoteBar tally={tally} className="mt-3" />
      <p className="num mt-1 text-[0.72rem] text-ink-3">{tally.total} of {Math.max(eligible, tally.total)} members voted</p>

      {open ? (
        <div className={cx("mt-3", compact && "sm:flex sm:items-center sm:justify-between sm:gap-3")}>
          <div role="group" aria-label={`Your vote on ${p.title}`} className="grid grid-cols-3 gap-1.5 sm:w-72">
            {CHOICES.map((c) => (
              <Button
                key={c.value}
                size="sm"
                variant={mine === c.value ? "dark" : "secondary"}
                aria-pressed={mine === c.value}
                disabled={busy !== null}
                onClick={() => void vote(c.value)}
                className="h-9"
              >
                {busy === c.value ? <Spinner size={12} /> : mine === c.value ? <IconCheck size={13} /> : c.value === "no" ? <IconClose size={13} /> : null}
                {c.label}
              </Button>
            ))}
          </div>
          {mine ? <p className="mt-1.5 text-[0.74rem] text-ink-3 sm:mt-0">You voted <span className="font-semibold text-ink">{mine}</span>. You can change it until voting closes.</p> : <p className="mt-1.5 text-[0.74rem] text-ink-3 sm:mt-0">One vote each; change it any time before it closes.</p>}
        </div>
      ) : null}
      {err ? <p role="alert" className="mt-2 text-[0.8rem] text-risk">{err}</p> : null}

      <div className="mt-3">
        <Verdict p={p} showSummary />
      </div>

      {metrics ? (
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {metrics.map((m) => (
            <div key={m.label} className="rounded-md bg-surface-2 p-2.5">
              <dt className="text-[0.72rem] leading-tight text-ink-2">{m.label}</dt>
              <dd className="num mt-1 flex items-baseline gap-1.5">
                {m.before !== undefined ? <span className="text-[0.78rem] text-ink-3 line-through">{metric(m.before, m.unit)}</span> : null}
                <span className="text-[1rem] font-semibold">{metric(m.after, m.unit)}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {!compact && votes.length ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Who voted">
          {[...votes].sort((a, b) => a.voter_name.localeCompare(b.voter_name)).map((v) => (
            <li key={v.id}>
              <Chip tone={v.choice === "yes" ? "good" : v.choice === "no" ? "risk" : "neutral"}>{v.voter_name}: {v.choice}</Chip>
            </li>
          ))}
        </ul>
      ) : null}

      {!compact && open && p.created_by_name === name ? (
        <div className="mt-3 border-t border-line pt-3">
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void close()}>{busy === "close" ? <Spinner size={12} /> : null} Close voting now</Button>
        </div>
      ) : null}
    </article>
  );
}
