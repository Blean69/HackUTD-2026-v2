import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx, hueFor, initials } from "@/lib/format";

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-2xl border border-line bg-surface shadow-card", className)} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ title, sub, right, id }: { title: string; sub?: string; right?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="font-display text-[1.15rem] font-semibold leading-tight tracking-tight">{title}</h2>
        {sub ? <p className="mt-0.5 text-[0.82rem] leading-snug text-ink-2">{sub}</p> : null}
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
  accent: "bg-accent-soft text-watch border-transparent",
};

export function Chip({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[0.72rem] font-medium leading-5", TONE[tone], className)}>
      {children}
    </span>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg" };
const BTN: Record<NonNullable<BtnProps["variant"]>, string> = {
  primary: "bg-brand text-brand-ink hover:bg-brand-strong hover:text-brand-ink disabled:opacity-50",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-surface-2 disabled:opacity-50",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50",
  danger: "bg-risk text-white hover:opacity-90 disabled:opacity-50",
};
const BTN_SIZE = { sm: "h-9 px-3 text-sm", md: "h-11 px-4 text-[0.95rem]", lg: "h-14 px-6 text-base" };

export function Button({ variant = "primary", size = "md", className, type = "button", ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cx("inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed", BTN[variant], BTN_SIZE[size], className)}
      {...rest}
    />
  );
}

export function Avatar({ name, size = 28, ring }: { name: string; size?: number; ring?: boolean }) {
  const h = hueFor(name);
  return (
    <span
      aria-hidden="true"
      className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold", ring && "ring-2 ring-surface")}
      style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${h} 55% 40%)`, color: "white" }}
    >
      {initials(name)}
    </span>
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
  return <span className={cx("inline-block h-2 w-2 rounded-full", c)} aria-hidden="true" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children ? <div className="mt-1 text-[0.82rem] text-ink-2">{children}</div> : null}
    </div>
  );
}

export function Money({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("num", className)}>{children}</span>;
}
