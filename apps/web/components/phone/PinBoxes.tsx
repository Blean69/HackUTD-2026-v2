"use client";
import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { cx } from "@/lib/format";
import { PIN_LENGTH } from "@/lib/phone";

/** A code as `PIN_LENGTH` slots; "" is an empty box. */
export type Digits = string[];
export const emptyDigits = (): Digits => Array.from({ length: PIN_LENGTH }, () => "");
export const digitsToPin = (d: Digits): string => d.join("");
export const isComplete = (d: Digits): boolean => d.every((x) => /^\d$/.test(x));

/**
 * Five single-digit boxes with the numeric keypad on phones. Masked unless `show`. Typing moves forward, Backspace steps back,
 * arrows move, and pasting "48151" (anywhere) fills the row. Nothing here is stored: the parent owns the digits.
 */
export function PinBoxes({
  label, digits, onChange, show, invalid, autoFocus, disabled, describedBy,
}: {
  label: string;
  digits: Digits;
  onChange: (next: Digits) => void;
  show: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  describedBy?: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(PIN_LENGTH - 1, i))];
    el?.focus();
    el?.select();
  };
  const set = (i: number, v: string) => onChange(digits.map((d, j) => (j === i ? v : d)));

  function onType(i: number, raw: string) {
    let typed = raw.replace(/\D/g, "");
    // No maxLength on the boxes, so a whole code inserted at once (password-manager or one-time-code autofill) reaches us intact.
    // A digit typed next to the one already there arrives as two characters: keep the new one.
    const old = digits[i] ?? "";
    if (old && typed.length === 2) typed = typed[0] === old && typed[1] !== old ? typed[1]! : typed[0] === old ? old : typed[0]!;
    if (!typed) return set(i, "");
    if (typed.length > 1) return fill(i, typed);
    set(i, typed);
    if (i < PIN_LENGTH - 1) focus(i + 1);
  }
  function fill(from: number, text: string) {
    const next = [...digits];
    let at = from;
    for (const ch of text.replace(/\D/g, "").slice(0, PIN_LENGTH)) {
      if (at >= PIN_LENGTH) break;
      next[at++] = ch;
    }
    onChange(next);
    focus(Math.min(at, PIN_LENGTH - 1));
  }
  function onKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      e.preventDefault();
      set(i - 1, "");
      focus(i - 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focus(i + 1);
    }
  }
  function onPaste(i: number, e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!/\d/.test(text)) return;
    e.preventDefault();
    fill(text.replace(/\D/g, "").length >= PIN_LENGTH ? 0 : i, text);
  }

  return (
    <div role="group" aria-label={label} aria-describedby={describedBy} className="flex gap-2">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type={show ? "text" : "password"}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          value={d}
          aria-label={`${label}, digit ${i + 1} of ${PIN_LENGTH}`}
          aria-invalid={invalid || undefined}
          onChange={(e) => onType(i, e.target.value)}
          onKeyDown={(e) => onKey(i, e)}
          onPaste={(e) => onPaste(i, e)}
          onFocus={(e) => e.currentTarget.select()}
          className={cx(
            "num h-14 w-11 min-w-0 flex-1 rounded-lg border bg-surface text-center text-[1.35rem] font-semibold text-ink outline-none transition-colors sm:w-12 sm:flex-none",
            "focus:border-brand focus:ring-2 focus:ring-brand/15 disabled:bg-surface-2 disabled:opacity-70",
            invalid ? "border-risk" : d ? "border-line-strong" : "border-line-strong hover:border-ink-3/50",
          )}
        />
      ))}
    </div>
  );
}
