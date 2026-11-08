"use client";
import dynamic from "next/dynamic";
import { BENTO, Skeleton } from "@/components/ui";
import { FamilyVotingCard } from "@/components/voting/FamilyVotingCard";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { useGoals, useRoomTables } from "@/lib/data/hooks";
import { HealthCard, TrendCard } from "./AnalysisCards";
import { KpiTiles } from "./KpiRow";
import { InsightCards } from "./InsightCards";
import { AccountsCard, GoalsCard, UpcomingCard } from "./ListCards";

const S = BENTO;

/** The credit math and its hooks load after first paint: the tile sits below the fold on every screen size. */
const CreditTile = dynamic(() => import("./CreditTile").then((m) => m.CreditTile), {
  ssr: false,
  loading: () => <Skeleton className="col-span-12 h-64 !rounded-lg xl:col-span-4" />,
});

function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-3" aria-busy="true" aria-label="Loading household">
      <Skeleton className="col-span-12 h-36 !rounded-lg xl:col-span-6" />
      <Skeleton className="col-span-6 h-36 !rounded-lg xl:col-span-3" />
      <Skeleton className="col-span-6 h-36 !rounded-lg xl:col-span-3" />
      <Skeleton className={`${S.twoThirds} h-80 !rounded-lg`} />
      <Skeleton className="col-span-12 h-80 !rounded-lg xl:col-span-4" />
      {[0, 1, 2].map((i) => <Skeleton key={i} className={`${S.third} h-56 !rounded-lg`} />)}
    </div>
  );
}

/**
 * The household dashboard as one bento grid: net worth (hero), cash flow and the forecast low; the trend beside the
 * health score; accounts, next bills and credit; goals and the family vote. Every number appears once; detail is one
 * tap away (Analytics, My Picture, Credit, Goals).
 */
export function Dashboard({ householdId }: { householdId: string }) {
  const fin = useRoomFinance(householdId);
  const goalsReady = useRoomTables(householdId, ["goal"]);
  const goals = useGoals(householdId);

  if (!fin.ready || !goalsReady) return <DashboardSkeleton />;
  const hasBills = fin.upcoming.length > 0;

  return (
    <div className="grid grid-cols-12 gap-3">
      <KpiTiles fin={fin} householdId={householdId} />

      <InsightCards fin={fin} />

      <TrendCard fin={fin} householdId={householdId} className={S.twoThirds} />
      <HealthCard fin={fin} householdId={householdId} className="col-span-12 xl:col-span-4" />

      {/* Phones: the family vote (the live, multiplayer card) comes right after health; from md it closes the grid beside Goals. */}
      <FamilyVotingCard householdId={householdId} className={`${S.half} md:order-2`} />

      <AccountsCard fin={fin} householdId={householdId} className={S.third} />
      {hasBills ? <UpcomingCard fin={fin} householdId={householdId} className={S.third} /> : null}
      <CreditTile householdId={householdId} className={hasBills ? "col-span-12 xl:col-span-4" : S.third} />

      <GoalsCard goals={goals} fin={fin} householdId={householdId} className={`${S.half} md:order-1`} />
    </div>
  );
}
