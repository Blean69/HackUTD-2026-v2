"use client";
import { useState } from "react";
import { setLocalIdentity, suggestName, useLocalIdentity } from "@/lib/data/identity";
import type { PresenceRole } from "@/lib/types";
import { Avatar, Button } from "./ui";

/** First-join sheet: everyone in a room needs a name the others can see. Never a dead end: "Join as <guest name>". */
export function NamePrompt({ title = "Who's joining?", onDone, context, advisor }: { title?: string; onDone?: (name: string) => void; context?: string; advisor?: boolean }) {
  const id = useLocalIdentity();
  const [name, setName] = useState("");
  const [placeholder] = useState(() => suggestName());
  const [role, setRole] = useState<PresenceRole>("guest");
  if (!id.ready || id.name) return null;
  const finalName = name.trim() || placeholder;
  const join = () => {
    setLocalIdentity(finalName, role);
    onDone?.(finalName);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="name-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          join();
        }}
        className="anim-sheet w-full max-w-md rounded-t-3xl border border-line bg-surface p-5 pb-safe shadow-card sm:rounded-3xl"
      >
        <div className="flex items-center gap-3">
          <Avatar name={finalName} size={44} />
          <div>
            <h2 id="name-title" className="font-display text-xl font-semibold leading-tight">{title}</h2>
            <p className="text-[0.84rem] text-ink-2">{context ?? "Everyone in the room sees your name next to what you say and do."}</p>
          </div>
        </div>
        <label htmlFor="display-name" className="mt-4 block text-sm font-medium">Your name</label>
        <input
          id="display-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          maxLength={32}
          autoComplete="given-name"
          className="mt-1 h-12 w-full rounded-xl border border-line-strong bg-bg px-3 text-base outline-none focus:border-brand"
        />
        <fieldset className="mt-3" hidden={advisor}>
          <legend className="text-sm font-medium">I am</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(["guest", "family"] as const).map((r) => (
              <label key={r} className={`flex h-11 cursor-pointer items-center justify-center rounded-xl border text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)] ${role === r ? "border-brand bg-brand-soft text-brand-strong" : "border-line-strong text-ink-2"}`}>
                <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="sr-only" />
                {r === "guest" ? "A guest / judge" : "A family member"}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" size="lg" className="mt-4 w-full">Join as {finalName}</Button>
      </form>
    </div>
  );
}
