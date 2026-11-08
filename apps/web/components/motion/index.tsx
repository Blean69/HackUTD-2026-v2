"use client";
/**
 * The motion system, kept deliberately small. Four ideas, all CSS-driven (keyframes in app/globals.css), opacity and
 * transform only, and all of them instant under prefers-reduced-motion:
 *
 *   <Reveal i={n}>        staggered entrance for heroes and lists (set i = position in the list)
 *   <StepTransition k=…>  re-keyed wrapper that slides a wizard step in from the direction of travel
 *   <CountUp value=…>     number tween on first show (and between later values)
 *   leaveThen(el, fn)     play a short exit on an element, then run fn (route hand-offs)
 */
import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { cx } from "@/lib/format";

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Staggered rise-in. Server-rendered, so it starts at first paint with no JavaScript and no layout shift. */
export function Reveal({
  i = 0, as, className, children, fade, style,
}: {
  i?: number;
  as?: ElementType;
  className?: string;
  children: ReactNode;
  /** A shorter, flatter fade for dense lists. */
  fade?: boolean;
  style?: CSSProperties;
}) {
  const Tag = as ?? "div";
  return (
    <Tag className={cx(fade ? "motion-fade" : "motion-rise", className)} style={{ ["--i" as string]: i, ...style }}>
      {children}
    </Tag>
  );
}

/** Slides its content in from the right (forward) or the left (back) whenever `k` changes. */
export function StepTransition({ k, dir, children, className }: { k: string; dir: "fwd" | "back"; children: ReactNode; className?: string }) {
  return (
    <div key={k} className={cx(dir === "back" ? "motion-step-back" : "motion-step-fwd", className)}>
      {children}
    </div>
  );
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Tweens from the previous value (0 on first show) to `value`. Returns the current frame's number. */
export function useTween(value: number, duration = 700): number {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  const raf = useRef(0);
  useEffect(() => {
    const start = from.current;
    if (prefersReducedMotion() || start === value) {
      from.current = value;
      raf.current = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(raf.current);
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = start + (value - start) * easeOut(t);
      from.current = v;
      setShown(v);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);
  return shown;
}

/** A number that counts up on first show. Tabular numerals so the width does not jitter. */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString("en-US"), duration, className }: { value: number; format?: (n: number) => string; duration?: number; className?: string }) {
  const v = useTween(value, duration);
  return (
    <span className={cx("num", className)} aria-label={format(value)}>
      <span aria-hidden="true">{format(v)}</span>
    </span>
  );
}

/** Play the shared exit animation on `el`, then call `next` (falls back to calling it straight away). */
export function leaveThen(el: HTMLElement | null, next: () => void, ms = 190): void {
  if (!el || prefersReducedMotion()) {
    next();
    return;
  }
  el.classList.add("motion-leave");
  window.setTimeout(next, ms);
}
