import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx, hueFor, initials } from "@/lib/format";
import { IconArrowDown, IconArrowUp } from "./icons";

/* ------------------------------------------------------------------------------------------------
   Cosign UI kit. White cards, thin borders, 8px radius, no shadows. Money is always tabular (`num`).
   ------------------------------------------------------------------------------------------------ */

export const inputCls =
  "h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-[0.9rem] text-ink outline-none placeholder:text-ink-3 focus:border-brand disabled:bg-surface-2 disabled:opacity-70";
export const selectCls =
  "h-9 rounded-md border border-line-strong bg-surface pl-3 pr-8 text-[0.85rem] font-medium text-ink outline-none focus:border-brand disabled:opacity-60";
export const labelCls = "mb-1 block text-[0.78rem] font-medium text-ink-2";

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-lg border border-line bg-surface", className)} {...rest}>
      {children}
    </div>
  );
}

/** Info glyph next to card titles: tap/click/hover/focus popover (see InfoTip.tsx; native title tooltips fail on phones). */
import { InfoTip } from "./InfoTip";
export { InfoTip };

/** A titled dashboard card. `title` renders as an h2 so each card is a labelled region. */
export function Panel({
  title, info, sub, right, children, className, bodyClassName, id,
}: {
  title: ReactNode;
  info?: string;
  sub?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const hid = id ? `${id}-h` : undefined;
  return (
    <section id={id} aria-labelledby={hid} className={cx("flex min-w-0 flex-col rounded-lg border border-line bg-surface", className)}>
      <header className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          <h2 id={hid} className="flex items-center gap-1.5 text-[0.95rem] font-semibold leading-tight tracking-tight">
            {title}
            {info ? <InfoTip text={info} label={typeof title === "string" ? title : undefined} /> : null}
          </h2>
          {sub ? <p className="mt-0.5 text-[0.76rem] leading-snug text-ink-3">{sub}</p> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </header>
      <div className={cx("min-w-0 flex-1 px-4 pb-4 pt-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[1.15rem] font-semibold leading-tight tracking-tight sm:text-[1.3rem]">{title}</h2>
        {sub ? <p className="mt-0.5 max-w-2xl text-[0.84rem] leading-snug text-ink-2">{sub}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

/** Lightweight in-page section heading (below a PageHeader). */
export function SectionTitle({ title, sub, right, id }: { title: string; sub?: string; right?: ReactNode; id?: string }) {
  return (
    <div className="mb-2.5 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h3 id={id} className="text-[0.95rem] font-semibold leading-tight tracking-tight">{title}</h3>
        {sub ? <p className="mt-0.5 text-[0.78rem] leading-snug text-ink-3">{sub}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export type Tone = "neutral" | "good" | "watch" | "risk" | "info" | "brand" | "accent";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  good: "bg-good-soft text-good border-transparent",
  watch: "bg-watch-soft text-watch border-transparent",
  risk: "bg-risk-soft text-risk border-transparent",
  info: "bg-info-soft text-info border-transparent",
  brand: "bg-brand-soft text-brand-strong border-transparent",
  accent: "bg-watch-soft text-watch border-transparent",
};
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink-2", good: "text-good", watch: "text-watch", risk: "text-risk", info: "text-info", brand: "text-brand-strong", accent: "text-watch",
};
export const TONE_BG: Record<Tone, string> = {
  neutral: "bg-ink-3", good: "bg-good", watch: "bg-watch", risk: "bg-risk", info: "bg-info", brand: "bg-brand", accent: "bg-watch",
};

export function Chip({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[0.72rem] font-medium leading-4", TONE[tone], className)}>
      {children}
    </span>
  );
}

/** "Live" pill used in the sidebar and on Table Mode. */
export function LivePill({ className, label = "Live", dark }: { className?: string; label?: string; dark?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.7rem] font-semibold leading-4", dark ? "bg-white/10 text-[#9ee3bd]" : "bg-good-soft text-good", className)}>
      <span className="anim-blink h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Signed change chip: "+12.6%". `good` decides colour (some numbers falling is good news). */
export function Delta({ value, text, good, className }: { value: number; text?: string; good?: boolean; className?: string }) {
  const up = value >= 0;
  const ok = good ?? up;
  const Icon = up ? IconArrowUp : IconArrowDown;
  return (
    <span className={cx("num inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[0.75rem] font-semibold leading-4", ok ? "bg-good-soft text-good" : "bg-risk-soft text-risk", className)}>
      <Icon size={11} strokeWidth={2.4} />
      {text ?? `${up ? "+" : ""}${value.toFixed(1)}%`}
    </span>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "dark" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg" };
const BTN: Record<NonNullable<BtnProps["variant"]>, string> = {
  primary: "bg-brand text-brand-ink hover:bg-brand-strong disabled:opacity-50",
  dark: "on-dark bg-dark text-white hover:bg-[var(--dark-hover)] disabled:opacity-50",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-surface-2 disabled:opacity-50",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50",
  danger: "bg-risk text-white hover:opacity-90 disabled:opacity-50",
};
const BTN_SIZE = { sm: "h-8 px-2.5 text-[0.8rem]", md: "h-10 px-3.5 text-[0.88rem]", lg: "h-12 px-5 text-[0.95rem]" };

export function Button({ variant = "primary", size = "md", className, type = "button", ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cx("inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-semibold transition-colors disabled:cursor-not-allowed", BTN[variant], BTN_SIZE[size], className)}
      {...rest}
    />
  );
}

/** Icon-only button: `label` is required so it always has an accessible name. */
export function IconButton({ label, className, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx("relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export type Presence = "online" | "idle" | "off";

export function Avatar({ name, size = 28, ring, dot, className }: { name: string; size?: number; ring?: boolean; dot?: Presence; className?: string }) {
  const h = hueFor(name);
  return (
    <span className={cx("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        aria-hidden="true"
        className={cx("inline-flex h-full w-full items-center justify-center rounded-full font-semibold", ring && "ring-2 ring-surface")}
        style={{ fontSize: Math.max(10, size * 0.38), background: `hsl(${h} 32% 36%)`, color: "white" }}
      >
        {initials(name)}
      </span>
      {dot ? (
        <span
          className={cx("absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-surface", dot === "online" ? "bg-[#22a05f]" : dot === "idle" ? "bg-[#d9a21b]" : "bg-[#b5bfba]")}
          style={{ width: Math.max(9, size * 0.34), height: Math.max(9, size * 0.34) }}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

export function Progress({ value, tone = "brand", label, className, height = "h-1.5" }: { value: number; tone?: Tone; label?: string; className?: string; height?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cx("overflow-hidden rounded-full bg-line", height, className)} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={cx("h-full rounded-full", TONE_BG[tone])} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="anim-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden="true" />;
}

export function StatusDot({ tone }: { tone: "good" | "watch" | "risk" | "info" | "neutral" }) {
  const c = { good: "bg-good", watch: "bg-watch", risk: "bg-risk", info: "bg-info", neutral: "bg-ink-3" }[tone];
  return <span className={cx("inline-block h-2 w-2 shrink-0 rounded-full", c)} aria-hidden="true" />;
}

export function Empty({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-md border border-dashed border-line-strong px-4 py-6 text-center", className)}>
      <p className="text-[0.88rem] font-medium text-ink">{title}</p>
      {children ? <div className="mt-1 text-[0.8rem] text-ink-2">{children}</div> : null}
    </div>
  );
}

export function Money({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("num", className)}>{children}</span>;
}

/** Tinted icon tile (goal / proposal thumbnails). No photos. */
export function IconTile({ children, tone = "brand", size = 40 }: { children: ReactNode; tone?: Tone; size?: number }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-lg", TONE[tone === "neutral" ? "brand" : tone])} style={{ width: size, height: size }} aria-hidden="true">
      {children}
    </span>
  );
}

/** Segmented control (tabs-as-buttons). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line-strong bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("h-7 rounded px-2.5 text-[0.78rem] font-medium transition-colors", value === o.value ? "bg-dark text-white" : "text-ink-2 hover:text-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Wrap a table so only it scrolls horizontally on phones. */
export function TableScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("relative -mx-1 overflow-x-auto px-1", className)}>{children}</div>;
}
