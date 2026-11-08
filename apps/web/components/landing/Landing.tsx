import Link from "next/link";
import type { CSSProperties } from "react";
import { BrandMark, IconArrowRight, IconCheck } from "@/components/icons";
import { CHALLENGE_NOTE, PRODUCT_NAME, SYNTHETIC_NOTE } from "@/lib/constants";

/*
 * The landing page. A server component with no client JavaScript of its own: the staggered entrance is pure CSS
 * (`motion-rise` in globals.css, opacity + transform, instant under reduced motion), so it starts at first paint.
 */

const at = (i: number): CSSProperties => ({ ["--i" as string]: i });

const STEPS = [
  { n: 1, title: "Connect a sandbox bank", text: "Pick a sample customer or use Plaid Link." },
  { n: 2, title: "Choose what to share", text: "Tick the accounts your household should see." },
  { n: 3, title: "Answer three questions", text: "Goals, home and comfort with risk." },
];

const INSIGHTS = [
  { tone: "bg-good", text: "Cash covers 4.1 months of spending" },
  { tone: "bg-watch", text: "Card interest costs about $420 a year" },
  { tone: "bg-good", text: "College fund is on track for 2034" },
];

/** A still of what the dashboard shows after setup, built from the synthetic demo family. */
function Preview() {
  return (
    <figure className="motion-rise w-full max-w-md justify-self-center lg:justify-self-end" style={at(3)}>
      <div className="rounded-xl border border-line bg-surface p-4 shadow-[0_12px_32px_-16px_rgb(11_58_44/0.22)] sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex -space-x-1" aria-hidden="true">
              {["#3d6b57", "#6b4f3d", "#3d566b"].map((c, i) => (
                <span key={c} className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[0.62rem] font-semibold text-white ring-2 ring-surface" style={{ background: c }}>
                  {["MR", "LR", "AR"][i]}
                </span>
              ))}
            </span>
            <span className="text-[0.88rem] font-semibold">Rivera Family</span>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[0.74rem] font-medium text-good">
            <span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden="true" />3 here now
          </span>
        </div>

        <div className="mt-5">
          <p className="text-[0.76rem] text-ink-3">Net worth</p>
          <p className="num mt-0.5 text-[1.9rem] font-semibold leading-none tracking-tight">$412,880</p>
          <p className="mt-1.5 text-[0.76rem] text-ink-2">
            <span className="num font-semibold text-good">+2.1%</span> in the last 90 days
          </p>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="text-[0.76rem] font-medium text-ink-3">First insights</p>
          <ul className="mt-2 space-y-2">
            {INSIGHTS.map((r, i) => (
              <li key={r.text} className="motion-rise flex items-center gap-2.5 text-[0.86rem]" style={at(5 + i)}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${r.tone}`} aria-hidden="true" />
                {r.text}
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-4 flex items-center gap-1.5 border-t border-line pt-3 text-[0.74rem] text-ink-3">
          <IconCheck size={13} strokeWidth={2.6} className="text-good" />
          Read 1,204 transactions in 9 traced steps
        </p>
      </div>
      <figcaption className="mt-2 text-center text-[0.74rem] text-ink-3">The demo household, a few seconds after setup</figcaption>
    </figure>
  );
}

export function Landing() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="motion-fade mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 rounded-md" aria-label={`${PRODUCT_NAME} home`}>
          <BrandMark size={28} />
          <span className="text-[1.1rem] font-semibold tracking-tight">{PRODUCT_NAME}</span>
        </Link>
        <Link href="/login" className="press inline-flex h-9 items-center rounded-md px-3 text-[0.88rem] font-medium text-ink-2 hover:bg-surface hover:text-ink">
          Log in
        </Link>
      </header>

      <main id="main" className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-4 pb-12 pt-6 sm:px-6 sm:pt-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:pb-20">
        <div className="max-w-xl">
          <p className="motion-rise text-[0.82rem] font-semibold text-brand-strong" style={at(0)}>
            Household finances, together
          </p>
          <h1 className="motion-rise mt-3 text-[2.05rem] font-semibold leading-[1.08] tracking-[-0.02em] text-ink sm:text-[2.75rem]" style={at(1)}>
            One shared room for your family&apos;s money.
          </h1>
          <p className="motion-rise mt-4 text-[1.02rem] leading-relaxed text-ink-2 sm:text-[1.08rem]" style={at(2)}>
            Connect a bank and answer three questions. AI agents read the numbers, check every goal against your real accounts and show each step they take.
          </p>

          <div className="motion-rise mt-7" style={at(3)}>
            <Link
              href="/onboarding"
              className="press group inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand px-6 text-[1rem] font-semibold text-brand-ink hover:bg-brand-strong sm:w-auto"
            >
              Get started
              <IconArrowRight size={18} className="transition-transform duration-150 group-hover:translate-x-0.5" />
            </Link>
            <p className="mt-3 text-[0.82rem] text-ink-3">About two minutes. Synthetic sandbox data only, never real money.</p>
          </div>

          <ol className="mt-10 grid gap-3 sm:grid-cols-3 sm:gap-4">
            {STEPS.map((s, i) => (
              <li key={s.n} className="motion-rise flex gap-3 sm:block" style={at(4 + i)}>
                <span className="num inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[0.74rem] font-semibold text-brand-strong">{s.n}</span>
                <span className="block sm:mt-2">
                  <span className="block text-[0.88rem] font-semibold leading-snug">{s.title}</span>
                  <span className="mt-0.5 block text-[0.8rem] leading-snug text-ink-3">{s.text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <Preview />
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-5 text-[0.76rem] leading-relaxed text-ink-3 sm:flex-row sm:justify-between sm:px-6">
          <p>{SYNTHETIC_NOTE}</p>
          <p>{CHALLENGE_NOTE}</p>
        </div>
      </footer>
    </div>
  );
}
