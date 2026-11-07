import { RoomShell } from "@/components/shell/RoomShell";

export default async function RoomLayout({ children, params }: { children: React.ReactNode; params: Promise<{ householdId: string }> }) {
  const { householdId } = await params;
  return <RoomShell householdId={decodeURIComponent(householdId)}>{children}</RoomShell>;
}
