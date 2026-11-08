import { cx } from "@/lib/format";

export type MascotMood = "happy" | "worried" | "cheer";

/** Penny, the household piggy bank. Pure SVG + CSS (see .penny-* in globals.css); idle bob, blink and a falling coin. */
export function Mascot({ mood = "happy", size = 44, className, title }: { mood?: MascotMood; size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}
      className={cx("penny", mood === "cheer" && "penny-cheer", className)}
    >
      <ellipse cx="32" cy="58" rx="17" ry="2.5" fill="var(--ink)" opacity="0.1" />
      <g className="penny-body">
        <circle className="penny-coin" cx="32" cy="9" r="5" fill="#f4c430" stroke="#c99a10" strokeWidth="1.5" />
        <path d="M51 34c5-1 8 3 6 7s-5 3-5 1" fill="none" stroke="#f08aa6" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="19" y="46" width="7" height="10" rx="3" fill="#f08aa6" />
        <rect x="38" y="46" width="7" height="10" rx="3" fill="#f08aa6" />
        <ellipse cx="32" cy="35" rx="22" ry="17" fill="#ffb7cb" />
        <path d="M12 38c2 9 11 14 20 14s18-5 20-14c-6 7-14 8-20 8s-14-1-20-8z" fill="#f08aa6" opacity="0.5" />
        <rect x="24" y="17" width="16" height="3.5" rx="1.75" fill="#b04a6a" />
        <path className="penny-ear" d="M17 23l-2-9 9 4z" fill="#f08aa6" />
        <path className="penny-ear" d="M43 20l7-6 1 9z" fill="#f08aa6" style={{ animationDelay: "0.4s" }} />
        <ellipse cx="14" cy="36" rx="7" ry="5.5" fill="#f9a0ba" />
        <circle cx="12" cy="36" r="1.3" fill="#8a2f4c" />
        <circle cx="16.5" cy="36" r="1.3" fill="#8a2f4c" />
        <g className="penny-eyes">
          <circle cx="26" cy="29" r="2.4" fill="#2a1520" />
          <circle cx="38" cy="29" r="2.4" fill="#2a1520" />
        </g>
        {mood === "worried" ? (
          <>
            <path d="M22 24l7 2M42 24l-7 2" stroke="#2a1520" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M46 24c1.5 2 2 3.5 0 5-2-1.5-1.5-3 0-5z" fill="#7dc8ff" />
          </>
        ) : (
          <path d="M28 40c2 2 6 2 8 0" fill="none" stroke="#8a2f4c" strokeWidth="1.6" strokeLinecap="round" />
        )}
        <circle cx="22" cy="34" r="2.6" fill="#ff8aa8" opacity="0.55" />
        {mood === "cheer" ? <path className="penny-spark" d="M54 12l1.5 3.5L59 17l-3.5 1.5L54 22l-1.5-3.5L49 17l3.5-1.5z" fill="#f4c430" /> : null}
      </g>
    </svg>
  );
}

/** Perches a small Penny on a card's top-right corner. The parent needs `relative`. */
export function Peek({ mood = "happy", size = 38 }: { mood?: MascotMood; size?: number }) {
  return <span className="pointer-events-none absolute right-3 top-2 z-[1]"><Mascot mood={mood} size={size} /></span>;
}
