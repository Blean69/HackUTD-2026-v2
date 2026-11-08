"use client";
import { useId } from "react";
import { IconMic, IconPhone } from "@/components/icons";
import { useNow } from "@/lib/data/finance-hooks";
import { cx } from "@/lib/format";
import { PRODUCT_NAME } from "@/lib/constants";
import { isCallActive, openCallSheet, useCall } from "@/lib/voiceCall/session";
import { useVoiceStatus } from "@/lib/voiceCall/health";

export const VOICE_OFFLINE_TEXT = "Voice is offline right now; try the Ask panel.";

export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** m:ss since the call went live (or the length of a finished call). */
export function CallClock({ startedAt, endedAt, className }: { startedAt: number | null; endedAt?: number | null; className?: string }) {
  const now = useNow(1000).getTime();
  if (!startedAt) return null;
  return <span className={cx("num", className)}>{clockText((endedAt ?? now) - startedAt)}</span>;
}

/**
 * The entry point to a call. Always rendered, never hidden: when the voice service does not answer its /health check it
 * looks disabled and says why on hover and focus, but a click still opens the sheet, which explains the fix.
 *
 *   header  desktop top bar (room header)
 *   card    inside the "Ask out loud" cards
 *   tab     the raised centre button of the phone tab bar
 */
export function TalkButton({ variant, className }: { variant: "header" | "card" | "tab"; className?: string }) {
  const voice = useVoiceStatus();
  const call = useCall();
  const tipId = useId();
  const active = isCallActive(call);
  const down = voice === "down" && !active;
  const label = `Talk to ${PRODUCT_NAME}`;
  const aria = active ? (call.phase === "live" ? "Return to your call" : "Return to the call that is connecting") : down ? `${label} (voice is offline)` : label;

  const inCall = active ? (
    call.phase === "live" ? <><CallClock startedAt={call.startedAt} /></> : <>Connecting</>
  ) : null;

  if (variant === "tab") {
    return (
      <button
        type="button"
        onClick={() => openCallSheet()}
        aria-label={aria}
        aria-disabled={down || undefined}
        aria-describedby={down ? tipId : undefined}
        className={cx("press relative flex h-14 w-full flex-col items-center justify-end gap-0.5 pb-1 text-2xs font-semibold", down ? "text-ink-3" : "text-ink", className)}
      >
        <span
          className={cx(
            "absolute -top-4 flex h-[3.25rem] w-[3.25rem] items-center justify-center rounded-full border-[3px] border-surface shadow-[0_0_0_1px_var(--line)]",
            down ? "bg-surface-3 text-ink-3" : active ? "bg-dark text-dark-ink" : "bg-brand text-brand-ink",
          )}
          aria-hidden="true"
        >
          {active ? <IconPhone size={21} /> : <IconMic size={22} />}
          {active ? <span className="anim-blink absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-online" /> : null}
        </span>
        <span className="num">{active ? inCall : "Talk"}</span>
        {down ? <span id={tipId} className="sr-only">{VOICE_OFFLINE_TEXT}</span> : null}
      </button>
    );
  }

  const base = "press inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold tracking-[-0.005em] transition-colors";
  const tone = down
    ? "border border-line-strong bg-surface-2 text-ink-3"
    : active
      ? "bg-dark text-dark-ink hover:bg-[var(--dark-hover)]"
      : "bg-brand text-brand-ink hover:bg-brand-hover";
  const size = variant === "card" ? "h-10 px-4 text-body" : "h-9 px-3.5 text-body";

  return (
    <span className={cx("group relative", className ?? "inline-flex")}>
      <button
        type="button"
        onClick={() => openCallSheet()}
        aria-label={aria}
        aria-disabled={down || undefined}
        aria-describedby={down ? tipId : undefined}
        title={down ? VOICE_OFFLINE_TEXT : undefined}
        className={cx(base, tone, size, down && "cursor-not-allowed")}
      >
        {active ? <IconPhone size={16} /> : <IconMic size={16} />}
        {active ? <>{call.phase === "live" ? "In call" : "Connecting"} {call.phase === "live" ? <CallClock startedAt={call.startedAt} /> : null}</> : label}
        {active && call.phase === "live" ? <span className="anim-blink h-1.5 w-1.5 rounded-full bg-online" aria-hidden="true" /> : null}
      </button>
      {down ? (
        <span
          id={tipId}
          role="tooltip"
          className="pop pointer-events-none absolute right-0 top-full z-40 mt-1.5 hidden w-60 rounded-md px-2.5 py-1.5 text-left text-caption font-medium text-ink-2 group-focus-within:block group-hover:block"
        >
          {VOICE_OFFLINE_TEXT}
        </span>
      ) : null}
    </span>
  );
}
