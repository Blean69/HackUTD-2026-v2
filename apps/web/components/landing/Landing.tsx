import Link from "next/link";
import type { CSSProperties } from "react";
import { ScoreGauge, HEALTH_BANDS } from "@/components/charts/ScoreGauge";
import { Sparkline } from "@/components/charts/Sparkline";
import { BrandMark, IconArrowRight, IconCheck } from "@/components/icons";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { CHALLENGE_NOTE, PRODUCT_NAME, SYNTHETIC_NOTE } from "@/lib/constants";

/*
 * The landing page. A server component: the staggered entrance is pure CSS (`motion-rise`, opacity + transform, instant
 * under reduced motion), so it starts at first paint. The only client islands are the theme toggle and the sparkline.
 */

const at = (i: number): CSSProperties => ({ ["--i" as string]: i });

const STEPS = [
  { n: "01", title: "Connect a sandbox bank", text: "Link a sandbox bank with Plaid, or use the demo bank." },
  { n: "02", title: "Choose what to share", text: "Tick the accounts your household should see." },
  { n: "03", title: "Answer three questions", text: "Goals, home and comfort with risk." },
];

const INSIGHTS = [
  { tone: "bg-good", text: "Cash covers 4.1 months of spending" },
  { tone: "bg-watch", text: "Card interest costs about $420 a year" },
  { tone: "bg-good", text: "College fund is on track for 2034" },
];

/** A smooth, slightly rising six-month series for the still. */
const TREND = [318, 316, 321, 327, 324, 331, 336, 333, 338, 342, 340, 344.8];

const btn = "press group inline-flex h-12 items-center justify-center gap-2 rounded-lg px-5 text-lead font-semibold";

/** A still of the dashboard after setup: the same bento the product uses, built from the synthetic demo family. */
function Preview() {
  return (
    <figure className="motion-rise w-full max-w-xl justify-self-center lg:col-start-2 lg:max-w-[34rem] lg:row-span-2 lg:row-start-1 lg:justify-self-end" style={at(3)}>
      <div className="card overflow-hidden !rounded-xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex -space-x-0.5" aria-hidden="true">
              {[
                ["MR", 152],
                ["DR", 28],
                ["ER", 212],
              ].map(([t, h]) => (
                <span key={t} className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[0.6rem] font-semibold text-white ring-2 ring-surface" style={{ background: `hsl(${h} 28% 42%)` }}>
                  {t}
                </span>
              ))}
            </span>
            <span className="display truncate text-label">Rivera Family</span>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-caption font-medium text-ink-2">
            <span className="anim-blink h-1.5 w-1.5 rounded-full bg-online" aria-hidden="true" />3 here now
          </span>
        </div>

        <div className="grid grid-cols-6 gap-2.5 bg-bg p-2.5 sm:gap-3 sm:p-3">
          <div className="card col-span-6 p-4 sm:col-span-4">
            <p className="text-caption font-medium text-ink-3">Net worth</p>
            <div className="mt-1 flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="figure text-kpi leading-none">$344,800</p>
                <p className="mt-2 text-caption text-ink-3">
                  <span className="num font-semibold text-good">+7.7%</span> in 6 months
                </p>
              </div>
              <Sparkline values={TREND} width={112} height={44} />
            </div>
          </div>
          <div className="card col-span-3 flex flex-col items-center justify-center px-2 pb-2 pt-3 sm:col-span-2">
            <ScoreGauge value={79} min={0} max={100} bands={HEALTH_BANDS} label="Household health" size={104} showRange={false} />
            <p className="-mt-1 text-2xs font-medium text-ink-3">Household health</p>
          </div>
          <div className="card col-span-3 p-4 sm:hidden">
            <p className="text-caption font-medium text-ink-3">Forecast low</p>
            <p className="figure mt-1 text-kpi-sm">$39,655</p>
            <p className="mt-1 text-2xs text-ink-3">around Nov 24</p>
          </div>
          <div className="card col-span-6 p-4">
            <p className="eyebrow">First insights</p>
            <ul className="mt-2.5 space-y-2">
              {INSIGHTS.map((r, i) => (
                <li key={r.text} className="motion-rise flex items-center gap-2.5 text-label text-ink" style={at(5 + i)}>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${r.tone}`} aria-hidden="true" />
                  {r.text}
                </li>
              ))}
            </ul>
            <p className="mt-3.5 flex items-start gap-1.5 border-t border-line pt-3 text-caption text-ink-3">
              <IconCheck size={13} strokeWidth={2.4} className="mt-0.5 shrink-0 text-good" />
              <span>
                Read <span className="num">1,204</span> transactions in <span className="num">9</span> traced agent steps
              </span>
            </p>
          </div>
        </div>
      </div>
      <figcaption className="mt-2.5 text-center text-caption text-ink-3">The demo household, a few seconds after setup</figcaption>
    </figure>
  );
}

export function Landing() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="motion-fade mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-md" aria-label={`${PRODUCT_NAME} home`}>
          <BrandMark size={28} />
          <span className="display text-[1.15rem]">{PRODUCT_NAME}</span>
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/login" className="press inline-flex h-9 items-center rounded-md px-3 text-body font-medium text-ink-2 hover:bg-surface hover:text-ink">
            Log in
          </Link>
        </div>
      </header>

      <main id="main" className="mx-auto grid w-full max-w-6xl flex-1 content-center items-center gap-x-14 gap-y-10 px-4 pb-14 pt-4 sm:px-6 sm:pt-10 lg:grid-cols-[1.05fr_1fr] lg:gap-y-10 lg:pb-20">
        <div className="w-full max-w-xl justify-self-center lg:justify-self-start">
          <p className="motion-rise inline-flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-2 pr-3 text-caption font-medium text-ink-2" style={at(0)}>
            <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" />
            Household finances, together
          </p>
          <h1 className="motion-rise display mt-5 text-[2.35rem] leading-[1.04] text-ink sm:text-[3.1rem] lg:text-[3.4rem]" style={at(1)}>
            One shared room for your family&apos;s money.
          </h1>
          <p className="motion-rise mt-5 max-w-lg text-[1.02rem] leading-relaxed text-ink-2 sm:text-[1.08rem]" style={at(2)}>
            Connect a bank and answer three questions. AI agents read the numbers, check every goal against your real accounts and show each step they take.
          </p>

          <div className="motion-rise mt-8 flex flex-col gap-2.5 sm:flex-row" style={at(3)}>
            <Link href="/onboarding" className={`${btn} bg-brand text-brand-ink hover:bg-brand-hover`}>
              Get started
              <IconArrowRight size={18} className="transition-transform duration-150 group-hover:translate-x-0.5" />
            </Link>
            <Link href="/login" className={`${btn} border border-line-strong bg-surface text-ink hover:bg-surface-2`}>
              Explore the demo
            </Link>
          </div>
          <p className="motion-rise mt-3 text-caption text-ink-3" style={at(3)}>
            About two minutes. Synthetic sandbox data only, never real money.
          </p>
        </div>

        <Preview />

        {/* Phones: after the preview. From lg: under the hero, beside the preview. */}
        <ol className="card grid w-full max-w-xl justify-self-center divide-y divide-line self-start lg:justify-self-start overflow-hidden sm:grid-cols-3 sm:divide-x sm:divide-y-0" aria-label="How setup works">
          {STEPS.map((s, i) => (
            <li key={s.n} className="motion-rise flex gap-3 px-4 py-3 sm:block sm:py-3.5" style={at(4 + i)}>
              <span className="num pt-px font-mono text-2xs font-medium text-brand-strong">{s.n}</span>
              <span className="block sm:mt-1">
                <span className="block text-label font-semibold text-ink">{s.title}</span>
                <span className="mt-0.5 block text-caption text-ink-3">{s.text}</span>
              </span>
            </li>
          ))}
        </ol>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-5 text-caption text-ink-3 sm:flex-row sm:justify-between sm:px-6">
          <p>{SYNTHETIC_NOTE}</p>
          <p>{CHALLENGE_NOTE}</p>
        </div>
      </footer>
    </div>
  );
}
