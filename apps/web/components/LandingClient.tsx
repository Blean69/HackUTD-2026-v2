"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark, IconActivity, IconArrowRight, IconChevron, IconCopy, IconUsers } from "@/components/icons";
import { NamePrompt } from "@/components/NamePrompt";
import { Chip, IconTile, Spinner, StatusDot } from "@/components/ui";
import { CHALLENGE_NOTE, DEMO_HOUSEHOLD_ID, PITCH, PRODUCT_NAME, SYNTHETIC_NOTE } from "@/lib/constants";
import { createSandbox, joinRoom } from "@/lib/data/actions";
import { useDataReady, useDataScope, usePresence, useRuns } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";

/** Shared layout for the lower-emphasis choices: tile, title + one line, optional meta, chevron. */
function ChoiceBody({ icon, title, sub, meta }: { icon: ReactNode; title: string; sub: string; meta?: ReactNode }) {
  return (
    <>
      <IconTile tone="brand" size={40}>{icon}</IconTile>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.95rem] font-semibold leading-tight">{title}</span>
        <span className="mt-0.5 block text-[0.82rem] leading-snug text-ink-2">{sub}</span>
        {meta ? <span className="mt-1.5 block" aria-live="polite">{meta}</span> : null}
      </span>
      <IconChevron size={18} className="shrink-0 text-ink-3" />
    </>
  );
}

const rowCls = "flex min-h-[4.5rem] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-70";

export function LandingClient() {
  const router = useRouter();
  const ident = useLocalIdentity();
  useDataScope("lobby");
  const ready = useDataReady();
  const demoPeople = usePresence(DEMO_HOUSEHOLD_ID);
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
      setErr(e instanceof Error ? e.message : "Couldn't create your private copy. Try the demo household instead.");
      setBusy(false);
    }
  }

  const here = ready ? (
    <Chip tone="good"><StatusDot tone="good" />{demoPeople.length} here now</Chip>
  ) : null;
  const runsMeta = ready ? <Chip>{runs.length} {runs.length === 1 ? "run" : "runs"}</Chip> : null;

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="on-dark bg-side text-side-ink">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <BrandMark size={30} />
            <span className="text-[1.15rem] font-semibold leading-none tracking-tight text-white">{PRODUCT_NAME}</span>
          </div>
          <Link href="/advisor" className="rounded-md px-2 py-1.5 text-[0.8rem] font-medium text-side-ink-2 hover:bg-white/10 hover:text-white">
            Advisor
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-8 pt-8 sm:px-6 sm:pt-12">
        <h1 className="max-w-2xl text-[1.35rem] font-semibold leading-snug tracking-tight sm:text-[1.6rem]">{PITCH}</h1>

        <div className="mt-6">
          <Link
            href="/onboarding"
            className="flex h-14 w-full items-center justify-center gap-2 rounded-md bg-dark px-6 text-[1rem] font-semibold text-white transition-colors hover:bg-[var(--dark-hover)] sm:w-auto sm:min-w-72 sm:justify-between"
          >
            Set up your household
            <IconArrowRight size={18} />
          </Link>
          <p className="mt-2 text-[0.8rem] text-ink-3">Add your people, accounts and goals to get your own financial room.</p>
        </div>

        <section aria-labelledby="explore-h" className="mt-9">
          <h2 id="explore-h" className="mb-2 text-[0.78rem] font-semibold uppercase tracking-wide text-ink-3">Or look around first</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            <li>
              <Link href={`/room/${DEMO_HOUSEHOLD_ID}`} className={rowCls}>
                <ChoiceBody
                  icon={<IconUsers size={20} />}
                  title="Explore the demo household"
                  sub="A shared family room with sample accounts, goals and live presence."
                  meta={here}
                />
              </Link>
            </li>
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() => (ident.name ? void startSandbox(ident.name) : setAskName(true))}
                className={rowCls}
              >
                {busy ? (
                  <IconTile tone="brand" size={40}><Spinner size={20} /></IconTile>
                ) : (
                  <IconTile tone="brand" size={40}><IconCopy size={20} /></IconTile>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.95rem] font-semibold leading-tight">{busy ? "Creating your private copy..." : "Start a private copy"}</span>
                  <span className="mt-0.5 block text-[0.82rem] leading-snug text-ink-2">The same demo family, just for you. Change anything without affecting anyone.</span>
                </span>
                <IconChevron size={18} className="shrink-0 text-ink-3" />
              </button>
            </li>
            <li>
              <Link href="/agents" className={rowCls}>
                <ChoiceBody
                  icon={<IconActivity size={20} />}
                  title="Open the agent trail"
                  sub="Every plan, tool call and result from the AI agents, step by step."
                  meta={runsMeta}
                />
              </Link>
            </li>
          </ul>
          {err ? <p role="alert" className="mt-3 rounded-md bg-risk-soft px-3 py-2 text-[0.84rem] text-risk">{err}</p> : null}
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-3xl space-y-1 px-4 py-5 text-[0.78rem] leading-relaxed text-ink-3 sm:px-6">
          <p>{SYNTHETIC_NOTE}</p>
          <p>{CHALLENGE_NOTE}</p>
        </div>
      </footer>

      {askName && !ident.name ? (
        <NamePrompt
          title="Name your copy"
          context="We'll copy the demo household just for you."
          onDone={(n) => {
            setAskName(false);
            void startSandbox(n);
          }}
        />
      ) : null}
    </div>
  );
}
