"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { IconBot, IconCar, IconCheck, IconClose, IconHome, IconPlane, IconTag } from "@/components/icons";
import { Button, Chip, Disclosure, ErrorNote, IconTile, Spinner, type Tone } from "@/components/ui";
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
const CHOICE_TEXT: Record<VoteChoice, string> = { yes: "text-good", no: "text-risk", abstain: "text-ink-3" };

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

/** The agent's affordability verdict, with a link to its run in Agent Trail. `full` adds the suggestion. */
export function Verdict({ p, full }: { p: Proposal; full?: boolean }) {
  const v = p.verdict ? VERDICT[p.verdict] : null;
  const summary = p.analysis?.summary ?? p.analysis?.headline;
  const waiting = !v && isOpen(p);
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {v ? <Chip tone={v.tone}>{v.label}</Chip> : waiting ? <Chip tone="brand"><Spinner size={11} /> Checking affordability</Chip> : <Chip>No verdict</Chip>}
        {p.run_id ? (
          <Link href={`/agents?run=${encodeURIComponent(p.run_id)}`} className="inline-flex items-center gap-1 text-label font-medium text-brand-strong hover:underline" title="Open this agent run in Agent Trail">
            <IconBot size={13} /> Agent analysis
          </Link>
        ) : v ? (
          <span className="text-caption text-ink-3">Quick estimate from your balances</span>
        ) : null}
      </p>
      {summary ? <p className={cx("mt-1.5 text-label leading-snug text-ink-2", !full && "line-clamp-2")}>{summary}</p> : null}
      {full && p.analysis?.suggestion ? <p className="mt-1 text-label leading-snug text-ink-2"><span className="font-medium text-ink">Suggestion:</span> {p.analysis.suggestion}</p> : null}
    </div>
  );
}

/**
 * One proposal. `compact` is the Dashboard layout (no metrics or voter names); `bare` drops the card chrome when it
 * already sits inside a Panel.
 */
export function ProposalCard({ proposal: p, votes, eligible, compact, bare }: { proposal: Proposal; votes: readonly Vote[]; eligible: number; compact?: boolean; bare?: boolean }) {
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
  const voters = !compact && votes.length ? [...votes].sort((a, b) => a.voter_name.localeCompare(b.voter_name)) : [];

  return (
    <article className={cx(!bare && "rounded-lg border border-line bg-surface p-3.5")} aria-label={`Proposal: ${p.title}`}>
      <div className="flex items-start gap-3">
        {!compact ? <IconTile tone={open ? "brand" : "neutral"} size={40}><ProposalIcon title={p.title} size={20} /></IconTile> : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-lead font-semibold leading-snug">{p.title}</h3>
          <p className="num mt-0.5 text-label text-ink-2">{proposalTerms(p)}{!compact ? <span className="text-ink-3"> · by {p.created_by_name}</span> : null}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {outcome ? <Chip tone={outcome.tone}>{outcome.label}</Chip> : null}
          <span className="text-caption text-ink-3">{whenText(p)}</span>
        </div>
      </div>

      <VoteBar tally={tally} eligible={eligible} className="mt-3" />

      {open ? (
        <div role="group" aria-label={`Your vote on ${p.title}`} className="mt-3 grid grid-cols-3 gap-1.5 sm:max-w-sm">
          {CHOICES.map((c) => (
            <Button
              key={c.value}
              size="sm"
              variant={mine === c.value ? "dark" : "secondary"}
              aria-pressed={mine === c.value}
              disabled={busy !== null}
              onClick={() => void vote(c.value)}
              className="h-10 sm:h-9"
            >
              {busy === c.value ? <Spinner size={12} /> : mine === c.value ? <IconCheck size={13} /> : c.value === "no" ? <IconClose size={13} /> : null}
              {c.label}
            </Button>
          ))}
        </div>
      ) : null}
      {err ? <ErrorNote className="mt-2 !py-2">{err}</ErrorNote> : null}

      {voters.length ? (
        <p className="mt-2.5 text-label text-ink-2" aria-label="Who voted">
          {voters.map((v, i) => (
            <span key={v.id}>{i ? " · " : ""}{v.voter_name} <span className={cx("font-medium", CHOICE_TEXT[v.choice])}>{v.choice}</span></span>
          ))}
        </p>
      ) : null}

      <div className="mt-3"><Verdict p={p} full={!compact} /></div>

      {metrics ? (
        <Disclosure summary="Show the numbers" className="mt-2">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {metrics.map((m) => (
              <div key={m.label} className="rounded-md bg-surface-2 p-2.5">
                <dt className="text-caption leading-tight text-ink-2">{m.label}</dt>
                <dd className="num mt-1 flex items-baseline gap-1.5">
                  {m.before !== undefined ? <span className="text-label text-ink-3 line-through">{metric(m.before, m.unit)}</span> : null}
                  <span className="text-lead font-semibold">{metric(m.after, m.unit)}</span>
                </dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      ) : null}

      {!compact && open && p.created_by_name === name ? (
        <div className="mt-2">
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void close()}>{busy === "close" ? <Spinner size={12} /> : null} Close voting now</Button>
        </div>
      ) : null}
    </article>
  );
}
