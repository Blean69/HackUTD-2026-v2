import type { Metadata } from "next";
import { ObligationsPage } from "@/components/obligations/ObligationsPage";

export const metadata: Metadata = { title: "Obligations" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <ObligationsPage householdId={decodeURIComponent(householdId)} />;
}
