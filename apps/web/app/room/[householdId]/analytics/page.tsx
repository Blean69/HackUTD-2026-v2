import type { Metadata } from "next";
import { AnalyticsPage } from "@/components/analytics/AnalyticsPage";

export const metadata: Metadata = { title: "Analytics" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <AnalyticsPage householdId={decodeURIComponent(householdId)} />;
}
