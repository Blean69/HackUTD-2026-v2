"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IconBot, IconChevron, IconKey, IconUsers, KeystoneMark } from "@/components/icons";
import { NamePrompt } from "@/components/NamePrompt";
import { Shell } from "@/components/Shell";
import { Spinner } from "@/components/ui";
import { DEMO_HOUSEHOLD_ID, PITCH, PRODUCT_NAME } from "@/lib/constants";
import { createSandbox, joinRoom } from "@/lib/data/actions";
import { useDataReady, usePresence, useRuns } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";

export function LandingClient() {
  const router = useRouter();
  const ident = useLocalIdentity();
  const ready = useDataReady();
  const rivera = usePresence(DEMO_HOUSEHOLD_ID);
  const runs = useRuns();
  const [askName, setAskName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Hang out in the lobby so advisors can see who is around.
  useEffect(() => {
    if (ready && ident.name) void joinRoom("", ident.name, ident.role);
  }, [ready, ident.name, ident.role]);

  async function startSandbox(name: string) {
    setErr(null);
    setBusy(true);
    try {
      const id = await createSandbox(DEMO_HOUSEHOLD_ID, name);
      router.push(`/room/${id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create your copy. Try the shared room instead.");
      setBusy(false);
    }
  }

  const door = "group relative flex min-h-[7.5rem] items-center gap-4 overflow-hidden rounded-3xl p-5 text-left transition-transform active:scale-[0.99] sm:min-h-[9rem] sm:p-6";

  return (
    <Shell mood="me" maxWidth="max-w-5xl">
      <section className="relative overflow-hidden pb-6 pt-4 sm:pt-10">
        <div className="pointer-events-none absolute -right-16 -top-10 text-brand-soft opacity-80 sm:right-0" aria-hidden="true">
          <KeystoneMark size={260} />
        </div>
        <p className="relative inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[0.78rem] font-medium text-ink-2">
          <span className="h-2 w-2 rounded-full bg-good" aria-hidden="true" /> Live financial room · synthetic data
        </p>
        <h1 className="relative mt-4 font-display text-[3.25rem] font-extrabold leading-[0.95] tracking-tight sm:text-7xl">{PRODUCT_NAME}</h1>
        <p className="relative mt-4 max-w-xl text-[1.08rem] leading-relaxed text-ink-2 sm:text-xl">{PITCH}</p>
      </section>

      <nav aria-label="Choose how to start" className="grid gap-3 sm:grid-cols-6">
        <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className={`${door} bg-brand text-brand-ink sm:col-span-4`}>
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15"><IconUsers size={28} /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-[1.45rem] font-bold leading-tight sm:text-3xl">Join the Riveras&apos; live room</span>
            <span className="mt-1 block text-[0.92rem] leading-snug opacity-90">A bakery family in Oak Cliff. Everyone who joins sees each other, the Huddle and every agent step, live.</span>
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[0.75rem] font-semibold">
              <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden="true" /> {ready ? `${rivera.length} here now` : "connecting…"}
            </span>
          </span>
          <IconChevron size={26} className="shrink-0 opacity-80 transition-transform group-hover:translate-x-1" />
        </Link>

        <button
          type="button"
          disabled={busy}
          onClick={() => (ident.name ? void startSandbox(ident.name) : setAskName(true))}
          className={`${door} border border-line-strong bg-surface text-ink shadow-card hover:border-brand sm:col-span-2 disabled:opacity-70`}
        >
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-watch">{busy ? <Spinner size={24} /> : <IconKey size={26} />}</span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-[1.25rem] font-bold leading-tight">Start my own private copy</span>
            <span className="mt-1 block text-[0.84rem] leading-snug text-ink-2">Same family, just for you. Change anything without affecting anyone.</span>
          </span>
        </button>

        <Link href="/agents" className={`${door} border border-[#26332e] bg-[#0a0f0d] text-[#dce7e2] sm:col-span-6`}>
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#17220a] text-[#76b900]"><IconBot size={26} /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-[1.25rem] font-bold leading-tight sm:text-2xl">Watch the agents</span>
            <span className="mt-1 block text-[0.88rem] leading-snug text-[#93a49e]">Every plan, tool call and result from the Nemotron agents, as it happens{ready ? ` · ${runs.length} runs so far` : ""}.</span>
          </span>
          <IconChevron size={24} className="shrink-0 text-[#76b900] transition-transform group-hover:translate-x-1" />
        </Link>
      </nav>

      {err ? <p role="alert" className="mt-3 rounded-xl bg-risk-soft px-4 py-3 text-sm text-risk">{err}</p> : null}

      <p className="mt-6 max-w-2xl text-[0.82rem] leading-relaxed text-ink-3">
        Synthetic data only: nothing here is real money or real people. The shared room is visible to everyone who joins; a private copy is yours alone.
        {" "}
        <Link href="/advisor" className="font-medium text-brand-strong underline underline-offset-2">Advisor view</Link>
      </p>
      {askName && !ident.name ? <NamePrompt title="Name your copy" context="We'll copy the Rivera household just for you." onDone={(n) => { setAskName(false); void startSandbox(n); }} /> : null}
    </Shell>
  );
}
