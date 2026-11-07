import type { Metadata } from "next";
import { HouseholdPage } from "@/components/household/HouseholdPage";

export const metadata: Metadata = { title: "Household" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <HouseholdPage householdId={decodeURIComponent(householdId)} />;
}
