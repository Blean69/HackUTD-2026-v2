"use client";
import dynamic from "next/dynamic";
import { IconActivity, IconAnalytics, IconBank, IconCalendar, IconCard, IconGauge, IconPiggy, IconSpark, IconTarget, IconTrend, IconVote, IconWallet } from "@/components/icons";
import { BENTO, Panel, Skeleton } from "@/components/ui";
import { FamilyVotingCard } from "@/components/voting/FamilyVotingCard";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { useGoals, useRoomTables } from "@/lib/data/hooks";
import { CashFlowChart } from "@/components/charts/lazy";
import { HealthCard, TrendCard } from "./AnalysisCards";
import { KpiTiles } from "./KpiRow";
import { AssetCard, InsightCards } from "./InsightCards";
import { GoalsCard, ProductStrip, UpcomingCard } from "./ListCards";
import { NextMoveCard } from "./NextMove";
import { DashboardLayout, type DashCard } from "./DashboardLayout";

const S = BENTO;

/** Today's dashboard as it reads from md up (Goals and the vote swap places there via `md:order-*`): the default layout. */
const DESKTOP_ORDER = ["next-move", "accounts", "kpis", "trend", "assets", "health", "insights", "cash-flow", "bills", "credit", "goals", "vote"];

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

  // From lg each card can be moved or hidden (DashboardLayout); `span` is its lg+ width. Below lg the classes on each card
  // apply as they always have. `H` makes a card fill its slot from lg, where it sits inside the layout's wrapper.
  const H = "lg:h-full";
  const cards: DashCard[] = [
    // PNC's brief in order: see the whole picture (six products), make sense of it (KPIs, health), the next move.
    { id: "next-move", title: "Your next move", icon: IconSpark, span: "lg:col-span-12", node: <NextMoveCard fin={fin} householdId={householdId} className={`col-span-12 ${H}`} /> },
    { id: "accounts", title: "Every account", icon: IconBank, span: "lg:col-span-12", node: <ProductStrip fin={fin} householdId={householdId} className={`col-span-12 ${H}`} /> },
    { id: "kpis", title: "Headline numbers", icon: IconAnalytics, span: "lg:col-span-12", group: true, node: <KpiTiles fin={fin} householdId={householdId} /> },
    { id: "trend", title: "Net worth trend", icon: IconTrend, span: "lg:col-span-12 xl:col-span-6", node: <TrendCard fin={fin} householdId={householdId} className={`col-span-12 xl:col-span-6 ${H}`} /> },
    { id: "assets", title: "Asset allocation", icon: IconPiggy, span: "lg:col-span-6 xl:col-span-3", node: <AssetCard fin={fin} className={`col-span-12 md:col-span-6 xl:col-span-3 ${H}`} /> },
    { id: "health", title: "Household health", icon: IconGauge, span: "lg:col-span-6 xl:col-span-3", node: <HealthCard fin={fin} householdId={householdId} className={`col-span-12 md:col-span-6 xl:col-span-3 ${H}`} /> },
    { id: "insights", title: "Savings and spending", icon: IconWallet, span: "lg:col-span-12", group: true, node: <InsightCards fin={fin} /> },
    {
      id: "cash-flow", title: "Cash flow", icon: IconActivity, span: "lg:col-span-12 xl:col-span-8",
      node: (
        <Panel id="cash-flow" title="Cash flow" sub="Income against expenses, with the projection" className={`col-span-12 xl:col-span-8 ${H}`}>
          <CashFlowChart months={fin.cash} height={230} />
        </Panel>
      ),
    },
    // Phones: the family vote (the live, multiplayer card) comes right after health; from md it closes the grid beside Goals.
    { id: "vote", title: "Family vote", icon: IconVote, span: "lg:col-span-6", node: <FamilyVotingCard householdId={householdId} className={`${S.half} md:order-2 ${H}`} /> },
    ...(hasBills ? [{ id: "bills", title: "Next bills", icon: IconCalendar, span: "lg:col-span-6", node: <UpcomingCard fin={fin} householdId={householdId} className={`${S.half} ${H}`} /> }] : []),
    {
      id: "credit", title: "Credit scores", icon: IconCard, span: hasBills ? "lg:col-span-6" : "lg:col-span-12 xl:col-span-8",
      node: <CreditTile householdId={householdId} className={`${hasBills ? S.half : "col-span-12 xl:col-span-8"} ${H}`} />,
    },
    { id: "goals", title: "Goals", icon: IconTarget, span: "lg:col-span-6", node: <GoalsCard goals={goals} fin={fin} householdId={householdId} className={`${S.half} md:order-1 ${H}`} /> },
  ];

  return <DashboardLayout householdId={householdId} cards={cards} defaultOrder={DESKTOP_ORDER} />;
}
