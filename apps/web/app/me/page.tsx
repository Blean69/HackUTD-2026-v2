import { redirect } from "next/navigation";
import { DEMO_HOUSEHOLD_ID } from "@/lib/constants";

/**
 * /me was the original household route. It now lands in the shared demo room.
 * `/me?talk=1` (the QR code on the demo card) carries on into the room with the voice call sheet open.
 */
export default async function MePage({ searchParams }: { searchParams: Promise<{ talk?: string | string[] }> }) {
  const { talk } = await searchParams;
  redirect(`/room/${DEMO_HOUSEHOLD_ID}${talk === "1" ? "?talk=1" : ""}`);
}
