import type { Metadata } from "next";
import { KidsPage } from "@/components/kids/KidsPage";

export const metadata: Metadata = { title: "Kids & Teens" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <KidsPage householdId={decodeURIComponent(householdId)} />;
}
