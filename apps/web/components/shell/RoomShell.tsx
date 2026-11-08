"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { NamePrompt } from "@/components/NamePrompt";
import { Card, Skeleton } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID } from "@/lib/constants";
import { joinRoom } from "@/lib/data/actions";
import { useConnection } from "@/lib/data/connection";
import { useDataReady, useDataScope, useHousehold } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { rememberHousehold } from "@/lib/lastHousehold";
import { AppShell } from "./AppShell";
import { RoomHeader } from "./RoomHeader";

function RoomSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading household">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className={`h-28 !rounded-lg ${i === 0 ? "col-span-2 lg:col-span-1" : ""}`} />)}</div>
      <div className="grid gap-3 lg:grid-cols-2"><Skeleton className="h-72 !rounded-lg" /><Skeleton className="h-72 !rounded-lg" /></div>
    </div>
  );
}

/** How long a missing household gets to arrive (a household created a moment ago on another device) before we say so. */
const NOT_FOUND_GRACE_MS = 3000;

/**
 * Layout for every /room/[householdId]/* page: connects the data scope, announces presence, and wraps pages in the
 * app chrome. Lives in a layout so navigating between room pages does not tear down the connection or presence.
 */
export function RoomShell({ householdId, children }: { householdId: string; children: ReactNode }) {
  const ident = useLocalIdentity();
  useDataScope("room", householdId);
  const ready = useDataReady();
  const conn = useConnection();
  const household = useHousehold(householdId);
  const found = !!household;
  // Only say "not found" once the data has had a moment to arrive; until then keep showing the skeleton.
  const [missingFor, setMissingFor] = useState("");
  useEffect(() => {
    if (!ready || found) return;
    const t = setTimeout(() => setMissingFor(householdId), NOT_FOUND_GRACE_MS);
    return () => clearTimeout(t);
  }, [ready, found, householdId]);
  const missing = ready && !found && missingFor === householdId;
  // The app falls back to in-browser demo data when SpacetimeDB does not answer in time. Households made elsewhere are
  // not in that copy, so say what actually happened instead of "not found".
  const offline = conn.kind === "mock" && /^hh_(onb|sbx)_/.test(householdId);
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
      {!ready || (!found && !missing) ? (
        <RoomSkeleton />
      ) : !found ? (
        <Card className="motion-rise mx-auto mt-10 max-w-md p-6 text-center">
          <h1 className="display text-h3">{offline ? "We can't reach the live database" : "We can't find that household"}</h1>
          <p className="mt-1.5 text-body text-ink-2">
            {offline
              ? "This page fell back to offline demo data, which only has the sample households. Try again in a moment."
              : "It may have been reset. Your other households are on the log-in page, and the demo household is always open."}
          </p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            {offline ? (
              <button type="button" onClick={() => window.location.reload()} className="press inline-flex h-10 items-center justify-center rounded-md bg-brand px-4 text-body font-semibold text-brand-ink hover:bg-brand-hover">
                Try again
              </button>
            ) : null}
            <Link
              href="/login"
              className={
                offline
                  ? "press inline-flex h-10 items-center justify-center rounded-md px-4 text-body font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink"
                  : "press inline-flex h-10 items-center justify-center rounded-md bg-brand px-4 text-body font-semibold text-brand-ink hover:bg-brand-hover"
              }
            >
              Log in
            </Link>
            <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className="press inline-flex h-10 items-center justify-center rounded-md px-4 text-body font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">
              Open the demo household
            </Link>
          </div>
        </Card>
      ) : (
        <>
          {children}
          <p className="mt-6 pb-2 text-center text-caption text-ink-3">Educational guidance, not financial advice. Demo households use synthetic data.</p>
        </>
      )}
      {ready && !name ? <NamePrompt context={found ? `You're joining ${household?.name ?? "a household"}. Everyone here sees your name next to what you say and do.` : undefined} /> : null}
    </AppShell>
  );
}
