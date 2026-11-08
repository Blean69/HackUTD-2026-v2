"use client";
import { useEffect, useRef } from "react";
import { IconMic, IconMicOff } from "@/components/icons";
import { Spinner } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { cx } from "@/lib/format";
import { getLevels, type Activity } from "@/lib/voiceCall/session";

/** Short status text under the orb; also what screen readers hear. */
export function activityLabel(activity: Activity, muted: boolean): string {
  if (muted) return "Muted. Nobody can hear you";
  switch (activity) {
    case "you": return "Hearing you";
    case "assistant": return `${PRODUCT_NAME} is speaking`;
    case "thinking": return "Thinking";
    case "listening": return "Listening";
    default: return "Connecting";
  }
}

/**
 * The speaking / listening indicator. Flat colours and a ring that grows with the audio level: your microphone while
 * you talk, the assistant's voice while it talks. The level is read on every animation frame straight from the call
 * module and written to the DOM, so the sheet does not re-render 60 times a second.
 */
export function LevelOrb({ activity, muted, live, size = 120 }: { activity: Activity; muted: boolean; live: boolean; size?: number }) {
  const ring = useRef<HTMLSpanElement>(null);
  const mode = useRef({ activity, muted });
  useEffect(() => {
    mode.current = { activity, muted };
  }, [activity, muted]);

  useEffect(() => {
    if (!live) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const loop = () => {
      const el = ring.current;
      if (el) {
        const { activity: a, muted: m } = mode.current;
        const l = getLevels();
        const v = m ? 0 : a === "assistant" ? l.bot : a === "you" ? l.user : 0;
        const k = reduce ? 0 : Math.min(1, v * 1.5);
        el.style.transform = `scale(${1 + k * 0.4})`;
        el.style.opacity = a === "assistant" || a === "you" ? String(0.28 + k * 0.6) : "0";
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [live]);

  const core = Math.round(size * 0.68);
  const talking = activity === "assistant";
  const you = activity === "you" && !muted;
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }} data-activity={muted ? "muted" : activity}>
      <span
        ref={ring}
        aria-hidden="true"
        className={cx("absolute inset-0 rounded-full border-2 opacity-0 transition-transform duration-75", talking ? "border-ink-2" : "border-brand")}
      />
      <span
        aria-hidden="true"
        className={cx(
          "relative flex items-center justify-center rounded-full border transition-colors",
          muted
            ? "border-line-strong bg-surface-2 text-ink-3"
            : talking
              ? "border-dark bg-dark text-dark-ink"
              : you
                ? "border-brand bg-brand text-brand-ink"
                : "border-line bg-surface-2 text-brand-strong",
        )}
        style={{ width: core, height: core }}
      >
        {muted ? <IconMicOff size={size * 0.26} /> : activity === "idle" ? <Spinner size={size * 0.24} /> : activity === "thinking" ? <ThinkingDots /> : <IconMic size={size * 0.26} />}
      </span>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="anim-blink h-2 w-2 rounded-full bg-current" style={{ animationDelay: `${i * 0.18}s` }} />
      ))}
    </span>
  );
}
