"use client";
import type { VoteTally } from "@/lib/data/hooks";
import { cx } from "@/lib/format";

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

/** Yes / No / Abstain progress bar plus the counts underneath. */
export function VoteBar({ tally, className }: { tally: VoteTally; className?: string }) {
  const { yes, no, abstain, total } = tally;
  const summary = `${yes} yes, ${no} no, ${abstain} abstain`;
  return (
    <div className={className}>
      <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-line" role="img" aria-label={total ? `Votes so far: ${summary}` : "No votes yet"}>
        {total ? (
          <>
            <span className="bg-good" style={{ width: `${(yes / total) * 100}%` }} />
            <span className="bg-risk" style={{ width: `${(no / total) * 100}%` }} />
            <span className="bg-[#aab6b0]" style={{ width: `${(abstain / total) * 100}%` }} />
          </>
        ) : null}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem]">
        {[
          { label: "Yes", n: yes, dot: "bg-good" },
          { label: "No", n: no, dot: "bg-risk" },
          { label: "Abstain", n: abstain, dot: "bg-[#aab6b0]" },
        ].map((x) => (
          <li key={x.label} className="flex items-center gap-1.5 text-ink-2">
            <span className={cx("h-2 w-2 rounded-full", x.dot)} aria-hidden="true" />
            <span className="num font-semibold text-ink">{x.n}</span> {x.label}
            {total ? <span className="num text-ink-3">({pct(x.n, total)}%)</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
