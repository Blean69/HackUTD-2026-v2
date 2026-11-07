"use client";
import { useState } from "react";
import { setLocalIdentity, suggestName, useLocalIdentity } from "@/lib/data/identity";
import type { PresenceRole } from "@/lib/types";
import { cx } from "@/lib/format";
import { Avatar, Button, inputCls, labelCls } from "./ui";

/** First-join dialog: everyone in a room needs a name the others can see. Never a dead end: "Join as <guest name>". */
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
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="name-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          join();
        }}
        className="anim-sheet w-full max-w-md rounded-t-xl border border-line bg-surface p-5 pb-safe sm:rounded-xl"
      >
        <div className="flex items-center gap-3">
          <Avatar name={finalName} size={40} />
          <div>
            <h2 id="name-title" className="text-[1.1rem] font-semibold leading-tight">{title}</h2>
            <p className="text-[0.82rem] leading-snug text-ink-2">{context ?? "Everyone in the room sees your name next to what you say and do."}</p>
          </div>
        </div>
        <label htmlFor="display-name" className={cx(labelCls, "mt-4")}>Your name</label>
        <input
          id="display-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          maxLength={32}
          autoComplete="given-name"
          className={cx(inputCls, "h-11 text-[1rem]")}
        />
        <fieldset className="mt-3" hidden={advisor}>
          <legend className={labelCls}>I am</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["guest", "family"] as const).map((r) => (
              <label key={r} className={cx("flex h-10 cursor-pointer items-center justify-center rounded-md border text-[0.85rem] font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]", role === r ? "border-brand bg-brand-soft text-brand-strong" : "border-line-strong text-ink-2")}>
                <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="sr-only" />
                {r === "guest" ? "A guest / judge" : "A family member"}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" size="lg" variant="dark" className="mt-4 w-full">Join as {finalName}</Button>
      </form>
    </div>
  );
}
