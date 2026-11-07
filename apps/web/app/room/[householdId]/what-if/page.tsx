import type { Metadata } from "next";
import { WhatIfStudio } from "@/components/whatif/WhatIfStudio";

export const metadata: Metadata = { title: "What-If Studio" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <WhatIfStudio householdId={decodeURIComponent(householdId)} />;
}
