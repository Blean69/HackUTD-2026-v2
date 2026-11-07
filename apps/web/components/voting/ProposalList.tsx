"use client";
import { useMemo, useState } from "react";
import { IconPlus } from "@/components/icons";
import { Button, Empty, SectionTitle, Skeleton } from "@/components/ui";
import { useDataReady, useMembers, useProposals, useVotes } from "@/lib/data/hooks";
import { NewProposalForm } from "./NewProposalForm";
import { isOpen, ProposalCard } from "./ProposalCard";

/** Full list of the household's proposals (Goals page): open first, then past decisions, with a New proposal form. */
export function ProposalList({ householdId }: { householdId: string }) {
  const ready = useDataReady();
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
        title="Family voting"
        sub="Anyone can propose a purchase or decision. Everyone votes live; an agent checks affordability."
        right={!adding ? <Button size="sm" variant="dark" onClick={() => setAdding(true)}><IconPlus size={14} /> New proposal</Button> : undefined}
      />
      {adding ? <div className="mb-3"><NewProposalForm householdId={householdId} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} /></div> : null}
      {!ready ? (
        <Skeleton className="h-48 !rounded-lg" />
      ) : proposals.length === 0 ? (
        <Empty title="No proposals yet">Start one with New proposal. The family can vote right away.</Empty>
      ) : (
        <div className="space-y-4">
          {open.length ? (
            <div className="grid gap-3 xl:grid-cols-2">
              {open.map((p) => <ProposalCard key={p.id} proposal={p} votes={byProposal.get(p.id) ?? []} eligible={eligible} />)}
            </div>
          ) : (
            <Empty title="Nothing is up for a vote">Past decisions are below.</Empty>
          )}
          {past.length ? (
            <div>
              <h4 className="mb-2 text-[0.78rem] font-semibold uppercase tracking-wide text-ink-3">Past decisions</h4>
              <div className="grid gap-3 xl:grid-cols-2">
                {past.map((p) => <ProposalCard key={p.id} proposal={p} votes={byProposal.get(p.id) ?? []} eligible={eligible} />)}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
