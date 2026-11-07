"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { IconArrowRight, IconPlus } from "@/components/icons";
import { Button, Empty, Panel } from "@/components/ui";
import { useMembers, useProposals, useVotes } from "@/lib/data/hooks";
import { NewProposalForm } from "./NewProposalForm";
import { isOpen, ProposalCard } from "./ProposalCard";

/** Dashboard card: the proposal that closes soonest, with live voting, plus a New proposal form. */
export function FamilyVotingCard({ householdId, className }: { householdId: string; className?: string }) {
  const proposals = useProposals(householdId);
  const votes = useVotes(householdId);
  const members = useMembers(householdId);
  const [adding, setAdding] = useState(false);
  const eligible = useMemo(() => members.filter((m) => m.role !== "child").length || members.length, [members]);
  const open = proposals.filter((p) => isOpen(p));
  const shown = open[0] ?? proposals[0];
  const mine = shown ? votes.filter((v) => v.proposal_id === shown.id) : [];

  return (
    <Panel
      id="family-voting"
      title="Family Voting"
      info="Anyone can propose a purchase or decision. Everyone votes live; an agent checks affordability."
      className={className}
      right={
        <Link href={`/room/${householdId}/goals#voting`} className="inline-flex items-center gap-1 text-[0.78rem] font-semibold text-brand-strong hover:underline">
          View history <IconArrowRight size={13} />
        </Link>
      }
    >
      {adding ? (
        <NewProposalForm householdId={householdId} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      ) : shown ? (
        <>
          <ProposalCard proposal={shown} votes={mine} eligible={eligible} compact />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}><IconPlus size={14} /> New proposal</Button>
            {open.length > 1 ? (
              <Link href={`/room/${householdId}/goals#voting`} className="text-[0.78rem] font-medium text-ink-2 hover:text-ink hover:underline">
                +{open.length - 1} more open
              </Link>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <Empty title="Nothing to vote on yet">Propose a purchase and everyone in the household can vote.</Empty>
          <Button className="mt-3" size="sm" variant="dark" onClick={() => setAdding(true)}><IconPlus size={14} /> New proposal</Button>
        </>
      )}
    </Panel>
  );
}
