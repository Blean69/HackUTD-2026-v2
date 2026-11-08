"use client";
import type { VoteTally } from "@/lib/data/hooks";
import { cx } from "@/lib/format";

/** Yes / No / Abstain bar with one line of counts underneath. */
export function VoteBar({ tally, eligible, className }: { tally: VoteTally; eligible?: number; className?: string }) {
  const { yes, no, abstain, total } = tally;
  const summary = `${yes} yes, ${no} no, ${abstain} abstain`;
  return (
    <div className={className}>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-line" role="img" aria-label={total ? `Votes so far: ${summary}` : "No votes yet"}>
        {total ? (
          <>
            <span className="bg-good" style={{ width: `${(yes / total) * 100}%` }} />
            <span className="bg-risk" style={{ width: `${(no / total) * 100}%` }} />
            <span className="bg-[#aab6b0]" style={{ width: `${(abstain / total) * 100}%` }} />
          </>
        ) : null}
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8rem] text-ink-2">
        {[
          { label: "yes", n: yes, dot: "bg-good" },
          { label: "no", n: no, dot: "bg-risk" },
          { label: "abstain", n: abstain, dot: "bg-[#aab6b0]" },
        ].map((x) => (
          <span key={x.label} className="inline-flex items-center gap-1.5">
            <span className={cx("h-2 w-2 rounded-full", x.dot)} aria-hidden="true" />
            <span className="num font-semibold text-ink">{x.n}</span> {x.label}
          </span>
        ))}
        {eligible ? <span className="num ml-auto text-ink-3">{total} of {Math.max(eligible, total)} voted</span> : null}
      </p>
    </div>
  );
}
