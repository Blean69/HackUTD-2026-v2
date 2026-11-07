import { redirect } from "next/navigation";
import { DEMO_HOUSEHOLD_ID } from "@/lib/constants";

/** /me was the original household route. It now lands in the shared demo room. */
export default function MePage() {
  redirect(`/room/${DEMO_HOUSEHOLD_ID}`);
}
