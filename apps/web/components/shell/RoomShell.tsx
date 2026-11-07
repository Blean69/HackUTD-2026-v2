"use client";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { NamePrompt } from "@/components/NamePrompt";
import { Button, Card, Skeleton } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID } from "@/lib/constants";
import { joinRoom } from "@/lib/data/actions";
import { useDataReady, useDataScope, useHousehold } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { rememberHousehold } from "@/lib/lastHousehold";
import { AppShell } from "./AppShell";
import { RoomHeader } from "./RoomHeader";

function RoomSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading household">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28 !rounded-lg" />)}</div>
      <div className="grid gap-3 lg:grid-cols-2"><Skeleton className="h-72 !rounded-lg" /><Skeleton className="h-72 !rounded-lg" /></div>
    </div>
  );
}

/**
 * Layout for every /room/[householdId]/* page: connects the data scope, announces presence, and wraps pages in the
 * app chrome. Lives in a layout so navigating between room pages does not tear down the connection or presence.
 */
export function RoomShell({ householdId, children }: { householdId: string; children: ReactNode }) {
  const ident = useLocalIdentity();
  useDataScope("room", householdId);
  const ready = useDataReady();
  const household = useHousehold(householdId);
  const found = !!household;
  const name = ident.name;
  const role = ident.role;

  useEffect(() => {
    if (found) rememberHousehold(householdId);
  }, [found, householdId]);

  // Presence: join when we know who we are and the room exists; step back to the lobby on the way out.
  useEffect(() => {
    if (!ready || !name || !found) return;
    void joinRoom(householdId, name, role);
    return () => {
      void joinRoom("", name, role);
    };
  }, [ready, name, role, found, householdId]);

  return (
    <AppShell householdId={householdId} header={found ? <RoomHeader householdId={householdId} /> : undefined}>
      {!ready ? (
        <RoomSkeleton />
      ) : !found ? (
        <Card className="mx-auto mt-8 max-w-md p-6 text-center">
          <h1 className="text-lg font-semibold">We can&apos;t find that household</h1>
          <p className="mt-1 text-sm text-ink-2">It may have been a private copy that was reset. The shared demo household is always open.</p>
          <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className="mt-4 inline-block">
            <Button>Open the demo household</Button>
          </Link>
        </Card>
      ) : (
        children
      )}
      {ready && !name ? <NamePrompt context={found ? `You're joining ${household?.name ?? "a household"}. Everyone here sees your name next to what you say and do.` : undefined} /> : null}
    </AppShell>
  );
}
