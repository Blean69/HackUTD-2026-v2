import type { Metadata } from "next";
import { RoomClient } from "@/components/room/RoomClient";

export const metadata: Metadata = { title: "Family room" };

export default async function RoomPage({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <RoomClient householdId={decodeURIComponent(householdId)} />;
}
