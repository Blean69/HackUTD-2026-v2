import Link from "next/link";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx, hueFor, initials } from "@/lib/format";
import { IconAlert, IconArrowDown, IconArrowUp, IconChevron, IconInfo } from "./icons";
import { InfoTip } from "./InfoTip";
import { AvatarPhoto } from "./AvatarPhoto";
import { Peek, type MascotMood } from "./Mascot";

/* ------------------------------------------------------------------------------------------------
   Brianotron UI kit ("Ledger", docs/design-system.md). Hairline cards on a cool canvas, one cobalt accent,
   no card shadows. Money is always tabular (`num`); headline figures use `.figure` (wide display face).

   Scales (use these, not one-off values):
     type     text-2xs 11 · caption 12 · label 13 · body 14 · lead 15 · h3 17 · h2 22 · h1 28 · kpi 32 / kpi-sm 22
     space    gaps of 2 / 3 / 6 (8 / 12 / 24 px); cards pad 16 px (p-4)
     radius   sm 4 chips · md 6 controls · lg 10 cards · xl 14 sheets
     buttons  one primary per view; secondary for alternatives; ghost for Back and low-stakes actions
     status   colour only carries meaning (good / watch / risk), always next to a word or an icon
   ------------------------------------------------------------------------------------------------ */

export const inputCls =
  "field-focus h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-body text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-ink-3/50 disabled:bg-surface-2 disabled:opacity-70";
export const selectCls =
  "field-focus h-9 rounded-md border border-line-strong bg-surface pl-3 pr-8 text-label font-medium text-ink outline-none disabled:opacity-60";
export const labelCls = "mb-1.5 block text-label font-medium text-ink-2";

/** Bento column spans for a `grid grid-cols-12 gap-3` (docs/design-system.md §7). */
export const BENTO = {
  full: "col-span-12",
  half: "col-span-12 md:col-span-6",
  third: "col-span-12 md:col-span-6 xl:col-span-4",
  twoThirds: "col-span-12 xl:col-span-8",
  quarter: "col-span-6 xl:col-span-3",
  hero: "col-span-12 xl:col-span-6",
} as const;

export function Card({ className, children, interactive, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div className={cx("card", interactive && "card-interactive", className)} {...rest}>
      {children}
    </div>
  );
}

/** Info glyph next to card titles: tap/click/hover/focus popover (see InfoTip.tsx; native title tooltips fail on phones). */
export { InfoTip };

/** A titled dashboard card. `title` renders as an h2 so each card is a labelled region. */
export function Panel({
  title, info, sub, right, children, className, bodyClassName, id, footer, flush, mascot,
}: {
  title: ReactNode;
  info?: string;
  sub?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
  /** One trailing row, usually a link to the full list ("All accounts"). */
  footer?: ReactNode;
  /** No body padding: for a `List` or a table that runs edge to edge. */
  flush?: boolean;
  /** Perch Penny on the card's corner. */
  mascot?: MascotMood;
}) {
  const hid = id ? `${id}-h` : undefined;
  return (
    <section id={id} aria-labelledby={hid} className={cx("card relative flex min-w-0 flex-col", className)}>
      {mascot ? <Peek mood={mascot} /> : null}
      <header className={cx("flex items-start justify-between gap-3 px-4 pt-3.5", mascot && "pr-14")}>
        <div className="min-w-0">
          <h2 id={hid} className="flex items-center gap-1.5 text-lead font-semibold tracking-[-0.01em] text-ink">
            {title}
            {info ? <InfoTip text={info} label={typeof title === "string" ? title : undefined} /> : null}
          </h2>
          {sub ? <p className="mt-0.5 text-caption text-ink-3">{sub}</p> : null}
        </div>
        {right ? <div className="-mt-1 shrink-0">{right}</div> : null}
      </header>
      <div className={cx("min-w-0 flex-1", flush ? "pb-1 pt-2" : "px-4 pb-4 pt-3", bodyClassName)}>{children}</div>
      {footer ? <div className="border-t border-line px-4 py-2.5 text-label">{footer}</div> : null}
    </section>
  );
}

/** Trailing "All accounts →" style link for a Panel footer. */
export function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1 rounded font-medium text-brand-strong hover:text-ink">
      {children}
      <IconChevron size={14} className="transition-transform duration-150 group-hover:translate-x-0.5" />
    </Link>
  );
}

export function PageHeader({ title, sub, right, eyebrow }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 sm:mb-5">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
        <h2 className="display text-[1.25rem] leading-tight text-ink sm:text-h2">{title}</h2>
        {sub ? <p className="mt-1 max-w-2xl text-label text-ink-2">{sub}</p> : null}
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
        <h3 id={id} className="text-lead font-semibold tracking-[-0.01em]">{title}</h3>
        {sub ? <p className="mt-0.5 text-caption text-ink-3">{sub}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export type Tone = "neutral" | "good" | "watch" | "risk" | "info" | "brand" | "accent";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-2",
  good: "bg-good-soft text-good",
  watch: "bg-watch-soft text-watch",
  risk: "bg-risk-soft text-risk",
  info: "bg-info-soft text-info",
  brand: "bg-brand-soft text-brand-strong",
  accent: "bg-brand-soft text-brand-strong",
};
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink-2", good: "text-good", watch: "text-watch", risk: "text-risk", info: "text-info", brand: "text-brand-strong", accent: "text-brand-strong",
};
export const TONE_BG: Record<Tone, string> = {
  neutral: "bg-ink-3", good: "bg-good", watch: "bg-watch", risk: "bg-risk", info: "bg-info", brand: "bg-brand", accent: "bg-brand",
};

export function Chip({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-caption font-medium", TONE[tone], className)}>
      {children}
    </span>
  );
}

/** "Live" pill used in the sidebar and on Table Mode. (`dark` is accepted for older call sites; the pill themes itself.) */
export function LivePill({ className, label = "Live" }: { className?: string; label?: string; dark?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-sm bg-good-soft px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-good", className)}>
      <span className="anim-blink h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Signed change: "+12.6%". `good` decides colour (some numbers falling is good news). `plain` drops the pill. */
export function Delta({ value, text, good, className, plain }: { value: number; text?: string; good?: boolean; className?: string; plain?: boolean }) {
  const up = value >= 0;
  const ok = good ?? up;
  const Icon = up ? IconArrowUp : IconArrowDown;
  return (
    <span
      className={cx(
        "num inline-flex items-center gap-0.5 text-caption font-semibold",
        plain ? (ok ? "text-good" : "text-risk") : cx("rounded-sm px-1.5 py-0.5", ok ? "bg-good-soft text-good" : "bg-risk-soft text-risk"),
        className,
      )}
    >
      <Icon size={11} strokeWidth={2.4} />
      {text ?? `${up ? "+" : ""}${value.toFixed(1)}%`}
    </span>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "dark" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg" };
const BTN: Record<NonNullable<BtnProps["variant"]>, string> = {
  primary: "bg-brand text-brand-ink hover:bg-brand-hover disabled:opacity-45",
  dark: "bg-dark text-dark-ink hover:bg-[var(--dark-hover)] disabled:opacity-45",
  secondary: "border border-line-strong bg-surface text-ink hover:border-ink-3/40 hover:bg-surface-2 disabled:opacity-50",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50",
  danger: "bg-risk text-white hover:opacity-90 disabled:opacity-50 dark:text-[#1a0706]",
};
const BTN_SIZE = { sm: "h-8 px-2.5 text-label", md: "h-9 px-3.5 text-body", lg: "h-12 px-5 text-lead" };

export function Button({ variant = "primary", size = "md", className, type = "button", ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cx(
        "press inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-semibold tracking-[-0.005em] disabled:cursor-not-allowed",
        size === "lg" && "rounded-lg",
        BTN[variant],
        BTN_SIZE[size],
        className,
      )}
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
      className={cx("press relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export type Presence = "online" | "idle" | "off";

/** Initials on a muted hue taken from the name. The same hue reads in both themes. */
export function Avatar({ name, size = 28, ring, dot, className }: { name: string; size?: number; ring?: boolean | "bg"; dot?: Presence; className?: string }) {
  const h = hueFor(name);
  return (
    <span className={cx("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        aria-hidden="true"
        className={cx("inline-flex h-full w-full items-center justify-center rounded-full font-semibold tracking-[0.01em]", ring && (ring === "bg" ? "ring-2 ring-bg" : "ring-2 ring-surface"))}
        style={{ fontSize: Math.max(10, size * 0.38), background: `hsl(${h} 28% 42%)`, color: "#fff" }}
      >
        {initials(name)}
      </span>
      <AvatarPhoto name={name} />
      {dot ? (
        <span
          className={cx("absolute -bottom-0.5 -right-0.5 rounded-full border-2", ring === "bg" ? "border-bg" : "border-surface", dot === "online" ? "bg-online" : dot === "idle" ? "bg-watch" : "bg-ink-3")}
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
    <div className={cx("overflow-hidden rounded-full bg-surface-3", height, className)} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={cx("bar-fill h-full rounded-full", TONE_BG[tone])} style={{ transform: `scaleX(${v / 100})` }} />
    </div>
  );
}

/**
 * A bar with threshold ticks (utilization, DTI). The fill takes the tone of the band the value falls in; the ticks show
 * where the next band starts, so a reader sees "how far from the line" without a legend.
 */
export function Meter({ value, max = 100, bands = [], label, className }: { value: number; max?: number; bands?: { to: number; tone: Tone }[]; label: string; className?: string }) {
  const v = Math.max(0, Math.min(max, value));
  const band = bands.find((b) => v <= b.to) ?? bands[bands.length - 1];
  const tone = band?.tone ?? "brand";
  return (
    <div className={cx("relative h-2", className)} role="meter" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <div className="absolute inset-0 overflow-hidden rounded-full bg-surface-3">
        <div className={cx("bar-fill h-full rounded-full", TONE_BG[tone])} style={{ transform: `scaleX(${v / max})` }} />
      </div>
      {bands.slice(0, -1).map((b) => (
        <span key={b.to} aria-hidden="true" className="absolute -top-0.5 h-3 w-0.5 rounded-full bg-surface" style={{ left: `calc(${(b.to / max) * 100}% - 1px)` }} />
      ))}
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

/** The one empty state: a calm line of what is missing and, optionally, what to do about it. */
export function Empty({ title, children, className, icon, action }: { title: string; children?: ReactNode; className?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx("flex flex-col items-center rounded-lg bg-surface-2 px-4 py-7 text-center", className)}>
      {icon ? <span className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-md border border-line bg-surface text-ink-3" aria-hidden="true">{icon}</span> : null}
      <p className="text-body font-medium text-ink">{title}</p>
      {children ? <div className="mt-1 max-w-sm text-label text-ink-2">{children}</div> : null}
      {action ? <div className="mt-3.5">{action}</div> : null}
    </div>
  );
}

/** The one error state: what went wrong in plain words, plus a way forward. */
export function ErrorNote({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cx("flex items-center gap-3 rounded-lg border border-risk/25 bg-risk-soft px-4 py-3 text-label text-risk", className)}>
      <IconAlert size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}

/** Inline callout with an icon. `error` is announced assertively; the rest politely. */
export function Notice({ tone = "info", children, live = "polite", action, className }: { tone?: "info" | "warn" | "error" | "good"; children: ReactNode; live?: "polite" | "assertive" | "off"; action?: ReactNode; className?: string }) {
  const cls = {
    info: "border-line bg-surface-2 text-ink-2",
    warn: "border-watch/25 bg-watch-soft text-watch",
    error: "border-risk/25 bg-risk-soft text-risk",
    good: "border-good/25 bg-good-soft text-good",
  }[tone];
  const Icon = tone === "info" || tone === "good" ? IconInfo : IconAlert;
  return (
    <div role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? undefined : live} className={cx("flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-label", cls, className)}>
      <Icon size={16} className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

const STAT_SIZE = { sm: "text-[1.125rem] leading-6", md: "text-[1.625rem] leading-8", lg: "text-[2.25rem] leading-10" } as const;

/** A labelled number: label, value, and an optional one-line context. Shared by every page that shows headline figures. */
export function Stat({
  label, value, sub, className, info, size = "md", delta, tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
  info?: string;
  size?: keyof typeof STAT_SIZE;
  delta?: ReactNode;
  tone?: "good" | "watch" | "risk";
}) {
  return (
    <div className={cx("min-w-0", className)}>
      <p className="flex items-center gap-1.5 text-label font-medium text-ink-2">
        {label}
        {info ? <InfoTip text={info} label={typeof label === "string" ? label : undefined} /> : null}
      </p>
      <p className={cx("figure mt-1 truncate", STAT_SIZE[size], tone ? TONE_TEXT[tone] : "text-ink")}>{value}</p>
      {sub || delta ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-3">
          {delta}
          {sub ? <span className="min-w-0">{sub}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** A bento KPI tile: a Card holding a Stat, with an optional chart slot (sparkline, mini gauge) and footer. */
export function StatCard({
  label, value, sub, info, delta, tone, size = "md", chart, footer, href, className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  info?: string;
  delta?: ReactNode;
  tone?: "good" | "watch" | "risk";
  size?: "sm" | "md" | "lg";
  /** Rendered to the right of the figure from `sm` up, under it on phones. */
  chart?: ReactNode;
  footer?: ReactNode;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <Stat label={label} value={value} sub={sub} info={href ? undefined : info} delta={delta} tone={tone} size={size} className="flex-1" />
        {chart ? <div className="hidden shrink-0 self-end sm:block">{chart}</div> : null}
      </div>
      {chart ? <div className="mt-3 sm:hidden">{chart}</div> : null}
      {footer ? <div className="mt-3 border-t border-line pt-2.5 text-caption text-ink-2">{footer}</div> : null}
    </>
  );
  const cls = cx("card motion-rise block h-full min-w-0 p-4 transition-transform duration-200 hover:-translate-y-0.5", size === "lg" && "lg:p-5", className);
  if (href) {
    return (
      <Link href={href} className={cx(cls, "card-interactive press")}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** A list with hairline dividers. `inset` draws its own rounded border (use outside a Panel). */
export function List({ children, className, inset, label }: { children: ReactNode; className?: string; inset?: boolean; label?: string }) {
  return (
    <ul aria-label={label} className={cx("divide-y divide-line", inset && "card overflow-hidden", className)}>
      {children}
    </ul>
  );
}

/**
 * The one list row: leading visual, title over a subtitle, trailing value, optional meta under the value. Navigating rows
 * (`href`) get a hover fill and a chevron; `onClick` rows get the fill; plain rows get neither.
 */
export function ListRow({
  title, sub, leading, trailing, meta, href, onClick, chevron, className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  meta?: ReactNode;
  href?: string;
  onClick?: () => void;
  chevron?: boolean;
  className?: string;
}) {
  const inner = (
    <>
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-ink">{title}</span>
        {sub ? <span className="mt-0.5 block truncate text-caption text-ink-3">{sub}</span> : null}
      </span>
      {trailing || meta ? (
        <span className="shrink-0 text-right">
          {trailing ? <span className="num block text-body font-semibold text-ink">{trailing}</span> : null}
          {meta ? <span className="mt-0.5 block text-caption text-ink-3">{meta}</span> : null}
        </span>
      ) : null}
      {(href && chevron !== false) || chevron ? <IconChevron size={16} className="-mr-1 shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" /> : null}
    </>
  );
  const cls = "group flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left";
  return (
    <li className={className}>
      {href ? (
        <Link href={href} className={cx(cls, "press transition-colors hover:bg-surface-2")}>
          {inner}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={cx(cls, "press transition-colors hover:bg-surface-2")}>
          {inner}
        </button>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}

/** Progressive disclosure: a styled native <details>, keyboard and screen-reader friendly with no JavaScript. */
export function Disclosure({ summary, children, className, defaultOpen }: { summary: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  return (
    <details className={cx("group", className)} open={defaultOpen}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-label font-medium text-brand-strong hover:text-ink [&::-webkit-details-marker]:hidden">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="transition-transform duration-200 group-open:rotate-90">
          <path d="m9 6 6 6-6 6" />
        </svg>
        {summary}
      </summary>
      <div className="anim-fade mt-2">{children}</div>
    </details>
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

/** Segmented control (tabs-as-buttons). The active segment is a raised surface on a sunken track. */
export function Segmented<T extends string>({
  value, onChange, options, label, size = "md", className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cx("inline-flex rounded-md bg-surface-3 p-0.5", className)}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            title={o.title}
            aria-label={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              "inline-flex items-center justify-center gap-1.5 rounded-[5px] font-medium transition-colors",
              size === "sm" ? "h-6 px-2 text-caption" : "h-7 px-2.5 text-caption",
              on ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line-strong)]" : "text-ink-3 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Underline tabs. Items with `href` are links (URL-driven tabs); otherwise `onChange` is called. */
export function Tabs<T extends string>({
  items, value, onChange, label, className,
}: {
  items: { value: T; label: ReactNode; href?: string; count?: number }[];
  value: T;
  onChange?: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cx("no-scrollbar -mx-4 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0", className)}>
      <ul className="flex gap-5">
        {items.map((t) => {
          const on = t.value === value;
          const cls = cx(
            "relative inline-flex h-10 items-center gap-1.5 whitespace-nowrap text-label font-medium transition-colors",
            on ? "text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-brand" : "text-ink-3 hover:text-ink",
          );
          const inner = (
            <>
              {t.label}
              {t.count !== undefined ? <span className="num rounded-sm bg-surface-3 px-1 text-2xs text-ink-2">{t.count}</span> : null}
            </>
          );
          return (
            <li key={t.value}>
              {t.href ? (
                <Link href={t.href} aria-current={on ? "page" : undefined} className={cls} scroll={false}>
                  {inner}
                </Link>
              ) : (
                <button type="button" aria-pressed={on} onClick={() => onChange?.(t.value)} className={cls}>
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Wrap a table so only it scrolls horizontally on phones. */
export function TableScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("relative -mx-1 overflow-x-auto px-1", className)}>{children}</div>;
}
