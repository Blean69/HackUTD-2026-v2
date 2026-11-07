import type { Metadata } from "next";
import { TableMode } from "@/components/table-mode/TableMode";

export const metadata: Metadata = { title: "Table Mode" };

export default async function Page({ params }: { params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <TableMode householdId={decodeURIComponent(householdId)} />;
}
