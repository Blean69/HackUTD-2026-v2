import type { Metadata } from "next";
import { MyPicture } from "@/components/picture/MyPicture";

export const metadata: Metadata = { title: "My Picture" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <MyPicture householdId={decodeURIComponent(householdId)} />;
}
