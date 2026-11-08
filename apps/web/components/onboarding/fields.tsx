"use client";
import type { ReactNode, Ref } from "react";
import { IconChevron } from "@/components/icons";
import { Button, Notice, Spinner } from "@/components/ui";
import { cx } from "@/lib/format";

/* Shared building blocks for the wizard. Inputs are 16px on phones so iOS never zooms on focus. */

export const fieldCls =
  "field-focus h-12 w-full rounded-lg border border-line-strong bg-surface px-3.5 text-base text-ink outline-none transition-colors placeholder:text-ink-3/70 hover:border-ink-3/50 disabled:bg-surface-2 disabled:opacity-70";

export function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-label font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1.5 text-caption text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  id, label, value, onChange, placeholder, hint, autoComplete, maxLength = 60, required, autoFocus, className, onFocus,
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
  onFocus?: () => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint} className={className}>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        required={required}
        autoFocus={autoFocus}
        aria-describedby={hint ? `${id}-hint` : undefined}
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
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true">
          $
        </span>
        <input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={value > 0 ? grouped.format(value) : ""}
          onChange={(e) => onChange(Math.min(max, digits(e.target.value)))}
          placeholder={placeholder}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={cx(fieldCls, "num pl-7")}
        />
      </div>
    </Field>
  );
}

/** A row of mutually exclusive choices (own / rent, risk levels). Native radios, so arrow keys work. */
export function ChoiceRow<T extends string | number>({
  name, value, onChange, options, label, className,
}: {
  name: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <fieldset className={className}>
      <legend className="sr-only">{label}</legend>
      <div className="grid gap-1 rounded-lg bg-surface-3 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label
              key={String(o.value)}
              className={cx(
                "press flex min-h-11 cursor-pointer items-center justify-center rounded-md px-2 text-center text-body font-medium leading-tight has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[var(--focus)]",
                on ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line-strong)]" : "text-ink-3 hover:text-ink",
              )}
            >
              <input type="radio" name={name} value={String(o.value)} checked={on} onChange={() => onChange(o.value)} className="sr-only" />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
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
        className={cx("relative mt-0.5 inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors", checked ? "bg-brand" : "bg-surface-3 shadow-[inset_0_0_0_1px_var(--line-strong)]")}
      >
        <span className="sr-only">{checked ? "On" : "Off"}</span>
        <span aria-hidden="true" className={cx("inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200", checked ? "translate-x-[1.5rem]" : "translate-x-[0.25rem]")} />
      </button>
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-body font-medium text-ink">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="mt-0.5 text-caption text-ink-2">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function StepHeading({ title, sub, headingRef, eyebrow }: { title: string; sub?: ReactNode; headingRef?: Ref<HTMLHeadingElement>; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6">
      {eyebrow ? <p className="eyebrow mb-2 text-brand-strong">{eyebrow}</p> : null}
      <h1 ref={headingRef} tabIndex={-1} className="display text-[1.5rem] leading-[1.15] text-ink outline-none sm:text-h1">
        {title}
      </h1>
      {sub ? <p className="mt-2 text-lead text-ink-2">{sub}</p> : null}
    </div>
  );
}

/**
 * Back plus the one primary action. Pinned to the bottom of the screen on phones so the next step is one thumb away;
 * inline at the end of the card from the sm breakpoint up.
 */
export function StepFooter({ onBack, children, note, backLabel = "Back" }: { onBack?: () => void; children?: ReactNode; note?: ReactNode; backLabel?: string }) {
  return (
    <div className="pb-safe sticky bottom-0 z-10 -mx-4 mt-8 border-t border-line bg-surface px-4 pt-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0">
      {note ? <div className="mb-2.5 text-caption text-ink-3">{note}</div> : null}
      <div className="flex items-center gap-2">
        {onBack ? (
          <Button variant="ghost" size="lg" onClick={onBack} className="-ml-2 px-3 sm:-ml-3">
            <IconChevron size={16} className="rotate-180" /> {backLabel}
          </Button>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none [&>*]:flex-1 sm:[&>*]:flex-none">{children}</div>
      </div>
    </div>
  );
}

/** Moved to the UI kit; re-exported so the wizard steps keep their imports. */
export { Notice };

export function BusyLabel({ busy, children, busyText }: { busy: boolean; children: ReactNode; busyText?: string }) {
  return (
    <>
      {busy ? <Spinner size={16} /> : null}
      {busy && busyText ? busyText : children}
    </>
  );
}

export const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
