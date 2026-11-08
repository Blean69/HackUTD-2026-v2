import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MyPicture } from "@/components/picture/MyPicture";
import { parsePictureTab } from "@/components/picture/tabs";

export const metadata: Metadata = { title: "My Picture" };

export default async function Page({ params, searchParams }: { params: Promise<{ householdId: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const { householdId } = await params;
  const { tab } = await searchParams;
  const t = Array.isArray(tab) ? tab[0] : tab;
  // Spending patterns live on Analytics now; old links to the Spending tab land there.
  if (t === "spending") redirect(`/room/${householdId}/analytics`);
  return <MyPicture householdId={decodeURIComponent(householdId)} initialTab={parsePictureTab(t)} />;
}
