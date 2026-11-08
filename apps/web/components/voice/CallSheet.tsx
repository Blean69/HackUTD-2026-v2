"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconAlert, IconArrowRight, IconCheck, IconChevronDown, IconClose, IconLock, IconMic, IconMicOff, IconPhone, IconSpark } from "@/components/icons";
import { Button, IconTile, LivePill, Spinner } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx } from "@/lib/format";
import { openCoach } from "@/lib/traceUi";
import { checkVoice, useVoiceStatus } from "@/lib/voiceCall/health";
import {
  closeCallSheet, enableSound, hangUp, interrupt, isCallActive, openCallSheet, pressTalk, releaseTalk, resetCall, retryCall, setHint, setPushToTalk,
  startCall, SUGGESTIONS, toggleMute, useCall,
  type Caption, type CallErrorKind, type CallState,
} from "@/lib/voiceCall/session";
import { HOLD_TO_TALK_CLASS, holdToTalkProps } from "@/lib/voiceCall/hold";
import { PhoneHint } from "@/components/phone/PhoneHint";
import { LevelOrb, activityLabel } from "./LevelOrb";
import { CallClock, clockText } from "./TalkButton";

export const DISCLOSURE = "You'll talk to an AI assistant. Audio is processed live and not stored.";

function openAskPanel() {
  closeCallSheet();
  openCoach();
}

// ------------------------------------------------------------------------------------------------ frame

const FOCUSABLE = 'button:not([disabled]), a[href], summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Bottom sheet on phones, centred dialog from md up. Escape and the scrim close it (a live call keeps running). */
function SheetFrame({
  title, subtitle, onClose, closeLabel, minimize, phaseKey, children, footer, right,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  closeLabel: string;
  minimize?: boolean;
  phaseKey: string;
  children: ReactNode;
  footer?: ReactNode;
  right?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const els = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [onClose]);

  // When the content swaps (idle -> connecting -> live ...) the focused button disappears; move focus to the new primary action.
  useEffect(() => {
    const el = panel.current?.querySelector<HTMLElement>("[data-autofocus]");
    (el ?? panel.current)?.focus({ preventScroll: true });
  }, [phaseKey]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4">
      <button type="button" aria-hidden="true" tabIndex={-1} onClick={onClose} className="scrim absolute inset-0 cursor-default" />
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="pop anim-dialog relative flex max-h-[92dvh] w-full flex-col rounded-t-xl outline-none md:max-h-[min(46rem,92dvh)] md:max-w-[30rem] md:rounded-xl"
      >
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-brand-strong" aria-hidden="true">
            <IconMic size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lead font-semibold leading-tight">{title}</h2>
            {subtitle ? <div className="mt-0.5 text-caption leading-snug text-ink-2">{subtitle}</div> : null}
          </div>
          {right}
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            className="-mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            {minimize ? <IconChevronDown size={20} /> : <IconClose size={18} />}
          </button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <footer className="pb-safe border-t border-line px-4 py-3">{footer}</footer> : null}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ pieces

function Disclosure({ className }: { className?: string }) {
  return (
    <p className={cx("flex items-start gap-2 text-label leading-snug text-ink-2", className)}>
      <IconLock size={15} className="mt-0.5 shrink-0 text-ink-3" />
      <span>{DISCLOSURE}</span>
    </p>
  );
}

function Prompts({ onPick, label = "Try asking", active, row }: { onPick: (p: string) => void; label?: string; active?: string | null; row?: boolean }) {
  return (
    <div>
      <p className="eyebrow mb-1.5">{label}</p>
      <div className={cx("flex gap-1.5", row ? "no-scrollbar -mx-4 overflow-x-auto px-4 pb-0.5" : "flex-wrap")} role="group" aria-label="Suggested questions">
        {SUGGESTIONS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            aria-pressed={active === p || undefined}
            className={cx(
              "rounded-md border px-2.5 py-1.5 text-left text-label font-medium transition-colors",
              row && "shrink-0 whitespace-nowrap",
              active === p ? "border-brand bg-brand-soft text-ink" : "border-line-strong bg-surface text-ink-2 hover:border-ink-3/50 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function platform(): "ios" | "android" | "safari" | "firefox" | "chromium" {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) return "safari";
  return "chromium";
}

function micSteps(): string[] {
  switch (platform()) {
    case "ios":
      return ["Tap the “aA” button in the address bar, then Website Settings.", "Set Microphone to Allow.", "Come back and tap Try again. If it still says blocked, reload the page."];
    case "android":
      return ["Tap the lock (or settings) icon next to the web address.", "Tap Permissions, then Microphone, and choose Allow.", "Come back and tap Try again."];
    case "safari":
      return ["In the menu bar choose Safari, then Settings for This Website.", "Set Microphone to Allow.", "Come back and click Try again."];
    case "firefox":
      return ["Click the microphone icon in the address bar and remove the block.", "Reload the page if the icon is gone.", "Click Try again."];
    default:
      return ["Click the lock (or settings) icon at the left of the address bar.", "Switch Microphone on, or set it to Allow.", "Click Try again."];
  }
}

interface ErrorCopy {
  title: string;
  body: string;
  steps?: string[];
  /** Primary action; the Ask panel is always offered as a way out. */
  primary: "retry" | "check" | "ask";
}

function errorCopy(kind: CallErrorKind): ErrorCopy {
  switch (kind) {
    case "mic-blocked":
      return { title: "Microphone is blocked", body: `${PRODUCT_NAME} can't hear you until this site is allowed to use the microphone. To fix it:`, steps: micSteps(), primary: "retry" };
    case "mic-missing":
      return { title: "No microphone found", body: "Plug in or switch on a microphone (a headset works), then try again. You can also use the Ask panel to type instead.", primary: "retry" };
    case "mic-busy":
      return { title: "The microphone is busy", body: "Another app or browser tab is using it. Close that, then try again.", primary: "retry" };
    case "offline":
      return { title: "Voice is offline right now", body: "Try the Ask panel instead. It answers the same questions by typing, with the same agents behind it.", primary: "ask" };
    case "cors":
      return { title: "The voice service is blocking this site", body: "It is running, but it isn't allowing this website to connect. A developer needs to add this site's address to the voice server's CORS list. Meanwhile, the Ask panel works.", primary: "ask" };
    case "busy":
      return { title: "The voice line is busy", body: "Lots of calls are happening at once. Wait a minute and try again, or use the Ask panel.", primary: "retry" };
    case "network":
      return {
        title: "Couldn't connect the audio",
        body: "The voice service is up, but your network isn't letting call audio through. Public and venue Wi-Fi often blocks this.",
        steps: ["Switch off Wi-Fi and use cellular data.", "Tap Try again.", "Still stuck? Use the Ask panel; it works on any network."],
        primary: "retry",
      };
    case "insecure":
      return { title: "Calls need a secure link", body: "Browsers only allow the microphone on https:// addresses. Open the secure address of this app (or scan its QR code again), or use the Ask panel.", primary: "ask" };
    case "unsupported":
      return { title: "This browser can't make calls", body: "Try Safari on iPhone, or Chrome on Android or a computer. The Ask panel works everywhere.", primary: "ask" };
    case "lost":
      return { title: "The connection dropped", body: "Check your signal and try again. If it keeps happening, switch off Wi-Fi and use cellular data.", primary: "retry" };
    default:
      return { title: "Something went wrong", body: "The call couldn't start. Try again; if it keeps happening, switch off Wi-Fi and use cellular data, or use the Ask panel.", primary: "retry" };
  }
}

function ErrorView({ kind, detail }: { kind: CallErrorKind; detail?: string }) {
  const c = errorCopy(kind);
  const [check, setCheck] = useState<"idle" | "checking" | "still">("idle");
  async function recheck() {
    if (check === "checking") return;
    setCheck("checking");
    const s = await checkVoice(true, 3500);
    if (s === "up") resetCall();
    else setCheck("still");
  }
  const canRecheck = c.primary === "ask" && kind !== "unsupported" && kind !== "insecure";
  return (
    <div className="space-y-4 p-4" role="alert">
      <div className="flex items-start gap-3">
        <IconTile tone="risk" size={40}><IconAlert size={20} /></IconTile>
        <div className="min-w-0">
          <h3 className="text-h3 font-semibold">{c.title}</h3>
          <p className="mt-1 text-body leading-snug text-ink-2">{c.body}</p>
        </div>
      </div>
      {c.steps ? (
        <ol className="list-decimal space-y-1.5 rounded-md border border-line bg-surface-2 py-3 pl-8 pr-3 text-body leading-snug text-ink marker:font-semibold marker:text-ink-3">
          {c.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
      ) : null}
      <div className="flex flex-col gap-2">
        {c.primary === "retry" ? (
          <>
            <Button size="lg" className="w-full" onClick={retryCall} data-autofocus><IconMic size={17} /> Try again</Button>
            <Button variant="secondary" size="lg" className="w-full" onClick={openAskPanel}><IconSpark size={17} /> Open the Ask panel</Button>
          </>
        ) : (
          <>
            <Button size="lg" className="w-full" onClick={openAskPanel} data-autofocus><IconSpark size={17} /> Open the Ask panel</Button>
            {canRecheck ? (
              <Button variant="secondary" size="lg" className="w-full" onClick={() => void recheck()} aria-disabled={check === "checking" || undefined}>
                {check === "checking" ? <><Spinner size={15} /> Checking…</> : check === "still" ? "Still offline. Check again" : "Check again"}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {check === "still" ? <p role="status" className="text-center text-label text-ink-3">No answer from the voice service yet.</p> : null}
      {detail ? (
        <details className="text-caption text-ink-3">
          <summary className="cursor-pointer rounded font-medium hover:text-ink">Technical details</summary>
          <p className="mt-1 break-words font-mono">{detail}</p>
        </details>
      ) : null}
    </div>
  );
}

function RunLink({ runId, onGo, children }: { runId: string; onGo: () => void; children: ReactNode }) {
  return (
    <Link
      href={`/agents?run=${encodeURIComponent(runId)}`}
      onClick={onGo}
      className="inline-flex items-center gap-1.5 rounded text-body font-semibold text-brand-strong hover:underline"
    >
      {children} <IconArrowRight size={14} />
    </Link>
  );
}

function Bubble({ c }: { c: Caption }) {
  const mine = c.role === "user";
  return (
    <li className={cx("anim-fade flex", mine ? "justify-end" : "justify-start")}>
      <div className={cx("max-w-[88%] rounded-lg px-3 py-2", mine ? "bg-brand-soft" : "border border-line bg-surface-2")}>
        <p className="mb-0.5 text-2xs font-semibold text-ink-3">{mine ? "You" : PRODUCT_NAME}</p>
        <p className="break-words text-body leading-relaxed text-ink">
          {c.text}
          {c.interim ? <span className="text-ink-3">{c.text ? " " : ""}{c.interim}</span> : null}
          {c.interrupted ? <span className="text-ink-3"> …</span> : null}
        </p>
      </div>
    </li>
  );
}

function Captions({ captions, live }: { captions: Caption[]; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const last = captions[captions.length - 1];
  const sig = `${captions.length}:${last?.text.length ?? 0}:${last?.interim.length ?? 0}`;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [sig]);
  return (
    <div ref={box} className="min-h-[7rem] flex-1 overflow-y-auto px-4 py-2" role="log" aria-label="Live captions" aria-live={live ? "polite" : "off"}>
      {captions.length ? (
        <ol className="space-y-2">{captions.map((c) => <Bubble key={c.id} c={c} />)}</ol>
      ) : (
        <p className="py-6 text-center text-label text-ink-3">{live ? "Captions appear here as you talk." : "No captions were captured."}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ phases

function IdleView({ householdId, name }: { householdId: string; name: string }) {
  const call = useCall();
  const voice = useVoiceStatus();
  if (voice === "down") return <ErrorView kind="offline" />;
  const start = () => startCall({ householdId, displayName: name });
  return (
    <div className="space-y-4 p-4">
      <p className="text-lead leading-snug text-ink">
        Ask {PRODUCT_NAME} about your accounts, bills and big purchases. It answers out loud, and every step it takes shows up in the Agent Trail.
      </p>
      <div className="space-y-2.5">
        <Button size="lg" className="w-full" onClick={start} data-autofocus><IconMic size={18} /> Start call</Button>
        <Disclosure />
      </div>
      <HoldToTalkToggle call={call} className="rounded-lg border border-line px-3.5 py-3" />
      <Prompts
        label="Or tap a question to start with"
        active={call.hint}
        onPick={(p) => {
          setHint(p);
          start();
        }}
      />
      <p className="flex items-center gap-1.5 text-caption text-ink-3">
        <span className={cx("h-2 w-2 rounded-full", voice === "up" ? "bg-good" : "bg-ink-3")} aria-hidden="true" />
        {voice === "up" ? "Voice line is online" : "Checking the voice line…"}
      </p>
    </div>
  );
}

function ExplainerView({ householdId, name }: { householdId: string; name: string }) {
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <IconTile size={40}><IconMic size={20} /></IconTile>
        <div className="min-w-0">
          <h3 className="text-h3 font-semibold">Allow your microphone</h3>
          <p className="mt-1 text-body leading-snug text-ink-2">{PRODUCT_NAME} needs to hear you. Your browser will ask first, and only this tab can use the microphone.</p>
        </div>
      </div>
      <ol className="list-decimal space-y-2 rounded-md border border-line bg-surface-2 py-3 pl-8 pr-3 text-body leading-snug text-ink marker:font-semibold marker:text-ink-3">
        <li>Tap <b>Allow microphone and start</b> below.</li>
        <li>When your browser asks, choose <b>Allow</b> (on iPhone, <b>Allow</b>; on Android, <b>While using the app</b> or <b>Allow</b>).</li>
        <li>Start talking. Hang up any time and the microphone switches off right away.</li>
      </ol>
      <Disclosure />
      <div className="flex flex-col gap-2">
        <Button size="lg" className="w-full" onClick={() => startCall({ householdId, displayName: name }, { skipExplainer: true })} data-autofocus>
          <IconMic size={18} /> Allow microphone and start
        </Button>
        <Button variant="ghost" size="lg" className="w-full" onClick={() => closeCallSheet()}>Not now</Button>
      </div>
    </div>
  );
}

function ConnectingView({ call }: { call: CallState }) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center" role="status" aria-live="polite">
      <LevelOrb activity="idle" muted={false} live={false} />
      <div>
        <p className="text-lead font-semibold">{call.step || "Connecting"}…</p>
        <p className="mt-0.5 text-label text-ink-2">This usually takes a few seconds. If your browser asks about the microphone, choose Allow.</p>
      </div>
      <Disclosure className="max-w-sm text-left" />
      <Button variant="secondary" size="lg" className="mt-1 w-full max-w-xs" onClick={hangUp} data-autofocus>Cancel</Button>
    </div>
  );
}

/** Why the mic is (or is not) reaching the assistant, in a few words. */
function micText(call: CallState): string {
  if (call.micLive) return call.pushToTalk ? "Mic live. Release to send" : "Mic live";
  if (call.muted) return "Muted";
  if (call.pushToTalk) return "Mic closed. Hold to talk";
  if (call.botSpeaking) return `Mic paused while ${PRODUCT_NAME} speaks`;
  return "Mic closed";
}

/** The one place that says whether anyone can hear you: a red live pill, or a quiet closed one. Never colour alone. */
function MicIndicator({ call }: { call: CallState }) {
  const live = call.micLive;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-semibold transition-colors",
        live ? "border-rec/30 bg-rec/10 text-rec" : "border-line bg-surface-2 text-ink-3",
      )}
    >
      {live ? <span className="anim-rec h-2 w-2 rounded-full bg-rec" aria-hidden="true" /> : <IconMicOff size={13} />}
      {micText(call)}
    </span>
  );
}

/** "Noisy room? Hold to talk": a switch row. The preference is remembered (lib/voiceCall/prefs). */
function HoldToTalkToggle({ call, className }: { call: CallState; className?: string }) {
  const id = useId();
  return (
    <div className={cx("flex items-center justify-between gap-3", className)}>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-label font-medium text-ink">Noisy room? Hold to talk</span>
        <span className="block text-caption text-ink-3">The mic only listens while you hold the button.</span>
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={call.pushToTalk}
        onClick={() => setPushToTalk(!call.pushToTalk)}
        className={cx("relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors", call.pushToTalk ? "bg-brand" : "bg-surface-3 shadow-[inset_0_0_0_1px_var(--line-strong)]")}
      >
        <span className="sr-only">{call.pushToTalk ? "On" : "Off"}</span>
        <span aria-hidden="true" className={cx("inline-block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200", call.pushToTalk ? "translate-x-[19px]" : "translate-x-[3px]")} />
      </button>
    </div>
  );
}

/** The big press-and-hold button (pointer, touch, and Space/Enter held from the keyboard). */
function HoldButton({ call }: { call: CallState }) {
  const held = call.talkHeld;
  return (
    <button
      type="button"
      {...holdToTalkProps(pressTalk, releaseTalk)}
      aria-pressed={held}
      aria-label={held ? "Talking. Release to send" : "Hold to talk"}
      data-autofocus
      className={cx(
        HOLD_TO_TALK_CLASS,
        "relative flex h-16 w-full items-center justify-center gap-2.5 rounded-xl text-lead font-semibold transition-[background-color,transform] duration-150",
        held ? "scale-[0.985] bg-rec text-white" : "bg-brand text-brand-ink hover:bg-brand-hover",
      )}
    >
      {held ? <span className="anim-rec h-2.5 w-2.5 rounded-full bg-white" aria-hidden="true" /> : <IconMic size={20} />}
      {held ? "Listening. Release to send" : "Hold to talk"}
      <span className="absolute bottom-1.5 hidden text-2xs font-medium opacity-70 md:block">{held ? "" : "or hold Space"}</span>
    </button>
  );
}

function LiveView({ call }: { call: CallState }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col items-center px-4 pt-4">
        <LevelOrb activity={call.activity} muted={call.muted} live size={104} />
        <p role="status" aria-live="polite" className="mt-2 text-lead font-semibold">{activityLabel(call.activity, call.muted)}</p>
        <div className="mt-1.5 flex items-center gap-2 text-label text-ink-2">
          <CallClock startedAt={call.startedAt} className="font-medium text-ink" />
          <MicIndicator call={call} />
        </div>
        {/* Phones (speakerphone guard): talk over the assistant without waiting for it to finish. */}
        {call.botSpeaking && !call.pushToTalk ? (
          <Button variant="secondary" size="sm" onClick={interrupt} className="anim-pop-in mt-2.5 md:hidden">
            <IconMic size={14} /> Interrupt
          </Button>
        ) : null}
      </div>

      {call.soundBlocked ? (
        <div className="mx-4 mt-3">
          <Button variant="dark" className="w-full" onClick={enableSound}>Tap to turn sound on</Button>
          <p className="mt-1 text-center text-caption text-ink-3">Your browser is holding the assistant&apos;s voice until you tap.</p>
        </div>
      ) : null}
      {call.notice ? <p role="alert" className="mx-4 mt-3 rounded-md bg-watch-soft px-3 py-2 text-label text-watch">{call.notice}</p> : null}
      {call.hint ? (
        <div className="mx-4 mt-3 rounded-md border border-brand/30 bg-brand-soft px-3 py-2">
          <p className="eyebrow text-brand-strong">Say it out loud</p>
          <p className="mt-0.5 text-lead font-medium leading-snug text-ink">“{call.hint}”</p>
        </div>
      ) : null}

      <Captions captions={call.captions} live />

      <div className="space-y-2.5 px-4 pb-1 pt-2">
        <Prompts label="Try saying" onPick={setHint} active={call.hint} row />
      </div>
    </div>
  );
}

function LiveFooter({ call }: { call: CallState }) {
  return (
    <div className="space-y-3">
      <HoldToTalkToggle call={call} />
      {call.pushToTalk ? <HoldButton call={call} /> : null}
      <div className={cx("grid gap-2.5", call.pushToTalk ? "grid-cols-1" : "grid-cols-2")}>
        {call.pushToTalk ? null : (
          <Button variant="secondary" size="lg" onClick={toggleMute} aria-pressed={call.muted} className={cx(call.muted && "border-ink-3 bg-surface-3")}>
            {call.muted ? <IconMicOff size={18} /> : <IconMic size={18} />} {call.muted ? "Unmute" : "Mute"}
          </Button>
        )}
        <Button variant="danger" size="lg" onClick={hangUp}>
          <IconPhone size={18} className="rotate-[135deg]" /> Hang up
        </Button>
      </div>
      {call.runId ? (
        <p className="text-center">
          <RunLink runId={call.runId} onGo={closeCallSheet}>See what the agent is doing</RunLink>
        </p>
      ) : null}
    </div>
  );
}

function EndedView({ call, householdId, name }: { call: CallState; householdId: string; name: string }) {
  const reason =
    call.endReason === "bot" ? `${PRODUCT_NAME} ended the call.` : call.endReason === "lost" ? "The connection dropped." : "You hung up.";
  const length = call.startedAt && call.endedAt ? clockText(call.endedAt - call.startedAt) : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 px-4 pt-4">
        <IconTile tone={call.endReason === "lost" ? "watch" : "good"} size={40}>{call.endReason === "lost" ? <IconAlert size={20} /> : <IconCheck size={20} />}</IconTile>
        <div className="min-w-0">
          <h3 className="text-h3 font-semibold">Call ended{length ? <span className="num font-normal text-ink-2"> · {length}</span> : null}</h3>
          <p className="mt-0.5 text-body leading-snug text-ink-2">
            {reason}
            {call.endReason === "lost" ? " Check your signal; if it keeps happening, switch off Wi-Fi and use cellular data." : ""}
          </p>
          <p className="mt-1 text-caption text-ink-3">Captions stay only while this window is open. Audio was never stored.</p>
        </div>
      </div>
      {call.runId ? (
        <div className="px-4 pt-3">
          <RunLink runId={call.runId} onGo={closeCallSheet}>See what the agent did</RunLink>
        </div>
      ) : null}
      <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-line pt-1">
        <Captions captions={call.captions} live={false} />
      </div>
      <div className="grid gap-2 px-4 pb-4 pt-2">
        <Button size="lg" onClick={() => startCall({ householdId, displayName: name }, { skipExplainer: true })} data-autofocus><IconMic size={18} /> Call again</Button>
        <Button variant="secondary" size="lg" onClick={() => closeCallSheet()}>Done</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the sheet

/** Mounted once in AppShell. The call itself lives in lib/voiceCall/session.ts, so closing or navigating does not hang up. */
export function CallSheet({ householdId }: { householdId: string }) {
  const call = useCall();
  if (!call.sheetOpen) return null;
  return <SheetContent call={call} householdId={householdId} />;
}

function SheetContent({ call, householdId }: { call: CallState; householdId: string }) {
  const ident = useLocalIdentity();
  const voice = useVoiceStatus();
  const name = ident.name ?? "Guest";
  const live = call.phase === "live";
  const title = `Talk to ${PRODUCT_NAME}`;
  const subtitle =
    call.phase === "live" ? "On a call" :
    call.phase === "connecting" ? "Connecting" :
    call.phase === "ended" ? "Call ended" :
    call.phase === "error" ? "Couldn't connect" :
    call.phase === "explainer" ? "One quick permission" :
    voice === "down" ? "Voice is offline" : "Ask about your money out loud";

  let body: ReactNode;
  switch (call.phase) {
    case "explainer": body = <ExplainerView householdId={householdId} name={name} />; break;
    case "connecting": body = <ConnectingView call={call} />; break;
    case "live": body = <LiveView call={call} />; break;
    case "ended": body = <EndedView call={call} householdId={householdId} name={name} />; break;
    case "error": body = <ErrorView kind={call.error?.kind ?? "unknown"} detail={call.error?.detail} />; break;
    default: body = <IdleView householdId={householdId} name={name} />;
  }

  return (
    <SheetFrame
      title={title}
      subtitle={subtitle}
      onClose={closeCallSheet}
      closeLabel={live || call.phase === "connecting" ? "Minimize call window" : "Close"}
      minimize={isCallActive(call)}
      phaseKey={`${call.phase}:${call.error?.kind ?? ""}:${voice === "down" ? "down" : "ok"}`}
      right={live ? <LivePill label="Live" className="mt-1" /> : undefined}
      footer={live ? <LiveFooter call={call} /> : call.phase === "connecting" ? undefined : <PhoneHint />}
    >
      {body}
    </SheetFrame>
  );
}

// ------------------------------------------------------------------------------------------------ floating pill

/** While a call runs and the sheet is closed (or you moved to another page), a small pill keeps it in reach. */
export function CallPill() {
  const call = useCall();
  if (!isCallActive(call) || call.sheetOpen) return null;
  return (
    <div className="pop fixed bottom-[4.75rem] left-4 z-40 flex items-center overflow-hidden rounded-full text-ink md:bottom-6 md:left-[calc(232px+1.5rem)]" role="group" aria-label="Voice call in progress">
      <button
        type="button"
        onClick={() => openCallSheet()}
        className="inline-flex h-11 items-center gap-2 pl-4 pr-3 text-body font-semibold hover:bg-surface-2"
        aria-label="Open the call window"
      >
        <span className={cx("h-2 w-2 rounded-full", call.micLive ? "anim-rec bg-rec" : "bg-ink-3")} aria-hidden="true" />
        {call.phase === "live" ? <>In call <CallClock startedAt={call.startedAt} /></> : <><Spinner size={13} /> Connecting</>}
      </button>
      <button
        type="button"
        onClick={hangUp}
        aria-label="Hang up"
        title="Hang up"
        className="inline-flex h-11 w-11 items-center justify-center bg-risk text-white hover:opacity-90 dark:text-[#1a0706]"
      >
        <IconPhone size={18} className="rotate-[135deg]" />
      </button>
    </div>
  );
}

