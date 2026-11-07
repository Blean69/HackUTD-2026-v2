"use client";
import type { ReactNode, Ref } from "react";
import { IconAlert, IconInfo } from "@/components/icons";
import { Button, labelCls, Spinner } from "@/components/ui";
import { cx } from "@/lib/format";

/* Shared building blocks for the onboarding steps. Inputs are 16px on phones so iOS never zooms on focus. */

export const fieldCls =
  "h-12 w-full rounded-md border border-line-strong bg-surface px-3 text-base text-ink outline-none placeholder:text-[#94a39b] focus:border-brand disabled:bg-surface-2 disabled:opacity-70";

export function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className={cx(labelCls, "text-[0.85rem]")}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[0.78rem] leading-snug text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function TextField({
  id, label, value, onChange, placeholder, hint, autoComplete, maxLength = 60, required, autoFocus, className,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  autoComplete?: string;
  maxLength?: number;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint} className={className}>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        required={required}
        autoFocus={autoFocus}
        className={fieldCls}
      />
    </Field>
  );
}

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const digits = (s: string) => parseInt(s.replace(/\D/g, "") || "0", 10);

/** Whole-dollar amount typed as digits, shown with thousands separators. */
export function MoneyField({
  id, label, value, onChange, hint, placeholder = "0", className, max = 1_000_000_000,
}: {
  id: string;
  label: ReactNode;
  value: number;
  onChange: (n: number) => void;
  hint?: ReactNode;
  placeholder?: string;
  className?: string;
  max?: number;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint} className={className}>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true">$</span>
        <input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={value > 0 ? grouped.format(value) : ""}
          onChange={(e) => onChange(Math.min(max, digits(e.target.value)))}
          placeholder={placeholder}
          className={cx(fieldCls, "num pl-7")}
        />
      </div>
    </Field>
  );
}

/** Small whole number such as an age. */
export function NumberField({
  id, label, value, onChange, max = 120, placeholder, className,
}: {
  id: string;
  label: ReactNode;
  value: number;
  onChange: (n: number) => void;
  max?: number;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Field label={label} htmlFor={id} className={className}>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        value={value > 0 ? String(value) : ""}
        onChange={(e) => onChange(Math.min(max, digits(e.target.value)))}
        placeholder={placeholder}
        className={cx(fieldCls, "num")}
      />
    </Field>
  );
}

/** On/off switch with a label and a plain-language explanation. The whole row is tappable. */
export function Switch({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors", checked ? "border-brand bg-brand" : "border-line-strong bg-line-strong")}
      >
        <span className="sr-only">{checked ? "On" : "Off"}</span>
        <span aria-hidden="true" className={cx("inline-block h-5 w-5 rounded-full bg-white transition-transform", checked ? "translate-x-[1.5rem]" : "translate-x-[0.25rem]")} />
      </button>
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-[0.92rem] font-medium leading-snug text-ink">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="mt-0.5 text-[0.8rem] leading-snug text-ink-2">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function StepHeading({ title, sub, headingRef }: { title: string; sub?: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <div className="mb-5">
      <h1 ref={headingRef} tabIndex={-1} className="text-[1.3rem] font-semibold leading-tight tracking-tight outline-none sm:text-[1.5rem]">
        {title}
      </h1>
      {sub ? <p className="mt-1.5 text-[0.92rem] leading-relaxed text-ink-2">{sub}</p> : null}
    </div>
  );
}

/** Back / Continue. Sticks to the bottom of the screen on phones so the next action is always one thumb away. */
export function StepFooter({ onBack, children, note }: { onBack?: () => void; children?: ReactNode; note?: ReactNode }) {
  return (
    <div className="pb-safe sticky bottom-0 z-10 -mx-4 mt-6 border-t border-line bg-surface px-4 pt-3 sm:-mx-6 sm:px-6">
      {note ? <div className="mb-2 text-[0.8rem] leading-snug text-ink-2">{note}</div> : null}
      <div className="flex items-center gap-2">
        {onBack ? (
          <Button variant="ghost" size="lg" onClick={onBack}>
            Back
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

export function Notice({ tone = "info", children, live = "polite", action }: { tone?: "info" | "warn" | "error" | "good"; children: ReactNode; live?: "polite" | "assertive" | "off"; action?: ReactNode }) {
  const cls = {
    info: "border-line bg-surface-2 text-ink-2",
    warn: "border-transparent bg-watch-soft text-watch",
    error: "border-transparent bg-risk-soft text-risk",
    good: "border-transparent bg-good-soft text-good",
  }[tone];
  const Icon = tone === "info" || tone === "good" ? IconInfo : IconAlert;
  return (
    <div role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? undefined : live} className={cx("flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[0.85rem] leading-snug", cls)}>
      <Icon size={17} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function BusyLabel({ busy, children, busyText }: { busy: boolean; children: ReactNode; busyText?: string }) {
  return (
    <>
      {busy ? <Spinner size={16} /> : null}
      {busy && busyText ? busyText : children}
    </>
  );
}

export const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
