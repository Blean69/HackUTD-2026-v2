"use client";
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "@/components/icons";
import { Avatar, Button } from "@/components/ui";
import { usePresence } from "@/lib/data/hooks";

/** Copies (or, on phones that support it, shares) the link to this setup so a family member can follow along. */
export function InviteButton({ householdId, householdName }: { householdId: string; householdName?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function invite() {
    const url = `${window.location.origin}/onboarding/${encodeURIComponent(householdId)}`;
    try {
      if (typeof navigator.share === "function" && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        await navigator.share({ title: householdName ? `${householdName} setup` : "Household setup", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // closed the share sheet
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2600);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" size="sm" onClick={() => void invite()}>
        {state === "copied" ? <IconCheck size={15} /> : <IconCopy size={15} />}
        {state === "copied" ? "Link copied" : "Invite family"}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? "Invite link copied to the clipboard" : state === "failed" ? "Couldn't copy the link" : ""}
      </span>
      {state === "failed" ? <span className="text-caption text-risk">Copy the address from your browser instead.</span> : null}
    </span>
  );
}

/** Who is here right now, plus the invite button. Anyone with the link sees the same progress live. */
export function PresenceBar({ householdId, householdName }: { householdId: string; householdName?: string }) {
  const present = usePresence(householdId);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <p className="text-caption font-medium text-ink-2" id="presence-h">
          {present.length > 1 ? "Setting up together" : "Here now"}
        </p>
        <ul className="flex min-w-0 flex-wrap items-center gap-1.5" aria-labelledby="presence-h">
          {present.length === 0 ? <li className="text-caption text-ink-3">just you</li> : null}
          {present.map((p) => (
            <li key={p.identity} className="inline-flex max-w-[11rem] items-center gap-1.5 rounded-full border border-line bg-surface-2 py-0.5 pl-0.5 pr-2.5">
              <Avatar name={p.display_name} size={22} dot="online" />
              <span className="truncate text-caption font-medium">
                {p.display_name.split(" ")[0]}
                {p.isMe ? <span className="font-normal text-ink-3"> (you)</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <InviteButton householdId={householdId} householdName={householdName} />
    </div>
  );
}
