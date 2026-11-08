"use client";
import { useMemo, useState } from "react";
import { IconChevron, IconPlus } from "@/components/icons";
import { Button, Chip, Empty, SectionTitle, Skeleton } from "@/components/ui";
import { tallyVotes, useMembers, useProposals, useRoomTables, useVotes } from "@/lib/data/hooks";
import { cx, usd } from "@/lib/format";
import { NewProposalForm } from "./NewProposalForm";
import { isOpen, ProposalCard } from "./ProposalCard";

/** Goals page: open proposals as full cards, past decisions as one expandable line each. */
export function ProposalList({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["proposal", "vote"]);
  const proposals = useProposals(householdId);
  const votes = useVotes(householdId);
  const members = useMembers(householdId);
  const [adding, setAdding] = useState(false);
  const eligible = useMemo(() => members.filter((m) => m.role !== "child").length || members.length, [members]);
  const byProposal = useMemo(() => {
    const m = new Map<string, typeof votes>();
    for (const v of votes) m.set(v.proposal_id, [...(m.get(v.proposal_id) ?? []), v]);
    return m;
  }, [votes]);
  const open = proposals.filter((p) => isOpen(p));
  const past = proposals.filter((p) => !isOpen(p));

  return (
    <section id="voting" aria-labelledby="voting-h" className="scroll-mt-20">
      <SectionTitle
        id="voting-h"
        title="Family votes"
        right={!adding ? <Button size="sm" variant="dark" onClick={() => setAdding(true)}><IconPlus size={14} /> New proposal</Button> : undefined}
      />
      {adding ? <div className="mb-3"><NewProposalForm householdId={householdId} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} /></div> : null}
      {!ready ? (
        <Skeleton className="h-48 !rounded-lg" />
      ) : proposals.length === 0 ? (
        <Empty title="No proposals yet">Start one with New proposal and the family can vote right away.</Empty>
      ) : (
        <div className="space-y-3">
          {open.length ? (
            <div className="grid gap-3 xl:grid-cols-2">
              {open.map((p) => <ProposalCard key={p.id} proposal={p} votes={byProposal.get(p.id) ?? []} eligible={eligible} />)}
            </div>
          ) : (
            <Empty title="Nothing is up for a vote">Past decisions are below.</Empty>
          )}
          {past.length ? (
            <div className="rounded-lg border border-line bg-surface">
              <h4 className="px-4 pt-3 text-[0.78rem] font-semibold text-ink-3">Past decisions</h4>
              <ul className="divide-y divide-line">
                {past.map((p) => {
                  const t = tallyVotes(byProposal.get(p.id) ?? []);
                  const approved = t.yes > t.no;
                  return (
                    <li key={p.id}>
                      <details className="group">
                        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-2.5 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                          <IconChevron size={14} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" />
                          <span className="min-w-0 flex-1 truncate text-[0.88rem] font-medium">{p.title}</span>
                          <span className="num shrink-0 text-[0.8rem] text-ink-2">{usd(p.amount)}</span>
                          <Chip tone={!t.total ? "neutral" : approved ? "good" : "risk"}>{!t.total ? "No votes" : approved ? "Approved" : "Not approved"}</Chip>
                        </summary>
                        <div className={cx("px-4 pb-4 pt-1")}>
                          <ProposalCard proposal={p} votes={byProposal.get(p.id) ?? []} eligible={eligible} bare />
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
