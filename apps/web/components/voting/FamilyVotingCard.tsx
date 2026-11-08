"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ViewAll } from "@/components/dashboard/AnalysisCards";
import { IconPlus } from "@/components/icons";
import { Button, Empty, Panel, Skeleton } from "@/components/ui";
import { useMembers, useProposals, useRoomTables, useVotes } from "@/lib/data/hooks";
import { NewProposalForm } from "./NewProposalForm";
import { isOpen, ProposalCard } from "./ProposalCard";

/** Dashboard card: the proposal that closes soonest, with live voting. History and new proposals are one tap away. */
export function FamilyVotingCard({ householdId, className }: { householdId: string; className?: string }) {
  const ready = useRoomTables(householdId, ["proposal", "vote"]);
  const proposals = useProposals(householdId);
  const votes = useVotes(householdId);
  const members = useMembers(householdId);
  const [adding, setAdding] = useState(false);
  const eligible = useMemo(() => members.filter((m) => m.role !== "child").length || members.length, [members]);
  const open = proposals.filter((p) => isOpen(p));
  const shown = open[0] ?? proposals[0];
  const mine = shown ? votes.filter((v) => v.proposal_id === shown.id) : [];
  const history = `/room/${householdId}/goals#voting`;

  return (
    <Panel id="family-voting" title="Family vote" className={className} right={<ViewAll href={history}>History</ViewAll>}>
      {!ready ? (
        <Skeleton className="h-40 !rounded-md" />
      ) : adding ? (
        <NewProposalForm householdId={householdId} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      ) : shown ? (
        <>
          <ProposalCard proposal={shown} votes={mine} eligible={eligible} compact bare />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}><IconPlus size={14} /> New proposal</Button>
            {open.length > 1 ? <Link href={history} className="text-[0.8rem] font-medium text-ink-2 hover:text-ink hover:underline">+{open.length - 1} more open</Link> : null}
          </div>
        </>
      ) : (
        <>
          <Empty title="Nothing to vote on yet">Propose a purchase and everyone can vote.</Empty>
          <Button className="mt-3" size="sm" variant="dark" onClick={() => setAdding(true)}><IconPlus size={14} /> New proposal</Button>
        </>
      )}
    </Panel>
  );
}
