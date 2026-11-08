"use client";
import { useState } from "react";
import { Avatar, Button } from "@/components/ui";
import { setLocalIdentity, suggestName } from "@/lib/data/identity";
import { fieldCls } from "./fields";

/** A family member opening the shared link: pick a name, then follow along. */
export function JoinCard({ householdName }: { householdName: string }) {
  const [name, setName] = useState("");
  const [placeholder] = useState(() => suggestName());
  const final = name.trim() || placeholder;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setLocalIdentity(final, "family");
      }}
    >
      <div className="mb-5 flex items-center gap-3">
        <Avatar name={final} size={44} />
        <div className="min-w-0">
          <h1 className="text-[1.45rem] font-semibold leading-tight tracking-tight">Join {householdName}</h1>
          <p className="text-body text-ink-2">A family member is setting this up. Add your name to watch it fill in, live.</p>
        </div>
      </div>
      <label htmlFor="join-name" className="mb-1.5 block text-body font-medium text-ink">
        Your name
      </label>
      <input id="join-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={32} autoComplete="given-name" autoFocus className={fieldCls} />
      <Button type="submit" size="lg" className="mt-5 w-full">
        Join as {final}
      </Button>
    </form>
  );
}
