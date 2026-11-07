import type { Metadata } from "next";
import { GoalsPage } from "@/components/goals/GoalsPage";

export const metadata: Metadata = { title: "Goals" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <GoalsPage householdId={decodeURIComponent(householdId)} />;
}
