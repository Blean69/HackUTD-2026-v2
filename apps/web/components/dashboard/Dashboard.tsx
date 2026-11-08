"use client";
import { Skeleton } from "@/components/ui";
import { FamilyVotingCard } from "@/components/voting/FamilyVotingCard";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { useGoals, useRoomTables } from "@/lib/data/hooks";
import { HealthCard, TrendCard } from "./AnalysisCards";
import { KpiRow } from "./KpiRow";
import { AccountsCard, GoalsCard, UpcomingCard } from "./ListCards";

function DashboardSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading household">
      <div className="grid grid-cols-3 gap-2.5 sm:gap-3 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className={`h-[7rem] !rounded-lg ${i === 0 ? "col-span-3 lg:col-span-1" : ""}`} />)}
      </div>
      <div className="grid gap-3 lg:grid-cols-3"><Skeleton className="h-80 !rounded-lg lg:col-span-2" /><Skeleton className="h-80 !rounded-lg" /></div>
      <div className="grid gap-3 lg:grid-cols-2"><Skeleton className="h-56 !rounded-lg" /><Skeleton className="h-56 !rounded-lg" /></div>
    </div>
  );
}

/**
 * The household dashboard: four headline numbers, the forecast, health, accounts, bills, goals and the family vote.
 * Every number appears once; the detail lives one tap away (My Picture for accounts, bills and spending, Goals for the
 * full list and vote history).
 */
export function Dashboard({ householdId }: { householdId: string }) {
  const fin = useRoomFinance(householdId);
  const goalsReady = useRoomTables(householdId, ["goal"]);
  const goals = useGoals(householdId);

  if (!fin.ready || !goalsReady) return <DashboardSkeleton />;
  const hasBills = fin.upcoming.length > 0;

  return (
    <div className="space-y-3">
      <KpiRow fin={fin} />

      <div className="grid gap-3 lg:grid-cols-3">
        <TrendCard fin={fin} className="lg:col-span-2" />
        <HealthCard fin={fin} />
      </div>

      {/* Two columns. A card with nothing to show (no bills on file yet) is left out and the next one moves up. */}
      <div className="grid gap-3 lg:grid-cols-2">
        <AccountsCard fin={fin} householdId={householdId} />
        {hasBills ? <UpcomingCard fin={fin} householdId={householdId} /> : null}
        <GoalsCard goals={goals} fin={fin} householdId={householdId} />
        <FamilyVotingCard householdId={householdId} className={hasBills ? undefined : "lg:col-span-2"} />
      </div>
    </div>
  );
}
