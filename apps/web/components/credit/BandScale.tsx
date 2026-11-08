import { BANDS, CREDIT_MAX, CREDIT_MIN, bandOf } from "@/lib/finance-credit";

const TONE_VAR = { risk: "var(--risk)", watch: "var(--watch)", good: "var(--good)" } as const;
const frac = (s: number) => (Math.max(CREDIT_MIN, Math.min(CREDIT_MAX, s)) - CREDIT_MIN) / (CREDIT_MAX - CREDIT_MIN);

/** The five bands as one thin bar with the score marked: a compact scale for tiles. */
export function BandScale({ score, className }: { score: number; className?: string }) {
  const f = frac(score);
  const band = bandOf(score);
  return (
    <div className={className}>
      <div className="relative flex h-1.5 gap-[2px]" aria-hidden="true">
        {BANDS.map((b) => (
          <span key={b.key} className="h-full rounded-full" style={{ flexGrow: b.max - b.min + 1, background: b.key === band.key ? TONE_VAR[b.tone] : "var(--line)" }} />
        ))}
        <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink bg-surface" style={{ left: `${f * 100}%` }} />
      </div>
    </div>
  );
}
