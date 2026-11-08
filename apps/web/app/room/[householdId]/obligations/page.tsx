import { redirect } from "next/navigation";

/** Folded into My Picture (one home for accounts, bills and spending). Old links and bookmarks land on the right tab. */
export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  redirect(`/room/${householdId}/picture?tab=bills`);
}
