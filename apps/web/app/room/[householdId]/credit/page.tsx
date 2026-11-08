import type { Metadata } from "next";
import { CreditPage } from "@/components/credit/CreditPage";

export const metadata: Metadata = { title: "Credit" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <CreditPage householdId={decodeURIComponent(householdId)} />;
}
