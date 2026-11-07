"use client";
import { AskOutLoudCard } from "@/components/voice/AskOutLoudCard";
import { FamilyVotingCard } from "@/components/voting/FamilyVotingCard";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { useGoals } from "@/lib/data/hooks";
import { useRange } from "@/lib/rangeUi";
import { AllocationCard, CashFlowCard, DebtCard, HealthCard, TrendCard } from "./AnalysisCards";
import { KpiRow } from "./KpiRow";
import { AccountsCard, ContributionCard, GoalsCard, UpcomingCard } from "./ListCards";

/**
 * The household dashboard. Rows follow the mockup: KPIs; trend / allocation / health; cash flow / debt / accounts /
 * obligations; goals / contributions / voting. Two columns on laptops, one on phones.
 */
export function Dashboard({ householdId }: { householdId: string }) {
  const fin = useRoomFinance(householdId);
  const goals = useGoals(householdId);
  const { label } = useRange();

  return (
    <div className="space-y-3">
      <KpiRow fin={fin} rangeLabel={label} />

      <AskOutLoudCard />

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-12">
        <TrendCard fin={fin} rangeLabel={label} className="lg:col-span-2 2xl:col-span-5" />
        <AllocationCard fin={fin} className="2xl:col-span-3" />
        <HealthCard fin={fin} className="2xl:col-span-4" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-12">
        <CashFlowCard fin={fin} className="2xl:col-span-3" />
        <DebtCard fin={fin} className="2xl:col-span-3" />
        <AccountsCard fin={fin} householdId={householdId} className="2xl:col-span-3" />
        <UpcomingCard fin={fin} householdId={householdId} className="2xl:col-span-3" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-12">
        <GoalsCard goals={goals} fin={fin} householdId={householdId} className="2xl:col-span-4" />
        <ContributionCard fin={fin} className="2xl:col-span-4" />
        <FamilyVotingCard householdId={householdId} className="lg:col-span-2 2xl:col-span-4" />
      </div>
    </div>
  );
}
