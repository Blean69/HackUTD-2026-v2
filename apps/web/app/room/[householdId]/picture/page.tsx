import type { Metadata } from "next";
import { MyPicture } from "@/components/picture/MyPicture";
import { parsePictureTab } from "@/components/picture/tabs";

export const metadata: Metadata = { title: "My Picture" };

export default async function Page({ params, searchParams }: { params: Promise<{ householdId: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const { householdId } = await params;
  const { tab } = await searchParams;
  return <MyPicture householdId={decodeURIComponent(householdId)} initialTab={parsePictureTab(Array.isArray(tab) ? tab[0] : tab)} />;
}
