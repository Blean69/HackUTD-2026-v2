"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconClose, IconPhone } from "@/components/icons";
import { Avatar } from "@/components/ui";
import { VOICE_NAME } from "@/lib/constants";
import { answerBrianCall, declineBrianCall, expireBrianCall } from "@/lib/data/actions";
import { useNow } from "@/lib/data/finance-hooks";
import { useIncomingCalls, useRoomTables } from "@/lib/data/hooks";
import { useVoiceStatus } from "@/lib/voiceCall/health";
import { isCallActive, openCallSheet, startCall, unlockCallAudio, useCall } from "@/lib/voiceCall/session";

/** A two-pulse ring every 3 seconds (a US ring cadence, two tones mixed), plus a vibration where the device has one. Best effort: browsers may block audio until the page has been touched. */
function startRinging(): () => void {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    void ctx.resume();
  } catch {
    ctx = null;
  }
  const pulse = (at: number) => {
    if (!ctx) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime + at);
    g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + at + 0.03);
    g.gain.setValueAtTime(0.12, ctx.currentTime + at + 0.37);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + at + 0.4);
    g.connect(ctx.destination);
    for (const f of [440, 480]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.42);
    }
  };
  const ring = () => {
    pulse(0);
    pulse(0.6);
    try {
      if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([400, 200, 400]); // browsers refuse before the first tap
    } catch {
      /* no vibration on this device */
    }
  };
  ring();
  const timer = setInterval(ring, 3000);
  return () => {
    clearInterval(timer);
    try {
      navigator.vibrate?.(0);
      void ctx?.close();
    } catch {
      /* already closed */
    }
  };
}

/**
 * Brian "calls" the household in the app (docs/contracts.md section 13): a full-screen incoming-call screen on every phone in the room.
 * The first Accept or Decline closes it for everyone (it is one `incoming_call` row). Accept first claims the ring, and only then opens the
 * normal in-app call in callback mode, so Brian opens with the alert exactly as the old phone callback did. Ring time is measured from when
 * THIS browser first saw the ring, so a phone with a wrong clock still rings for the full length.
 */
export function IncomingCall({ householdId, me }: { householdId: string; me: string }) {
  useRoomTables(householdId, ["incoming_call"]);
  const calls = useIncomingCalls(householdId);
  const now = useNow(1000).getTime();
  const call = useCall();
  const voice = useVoiceStatus();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const reported = useRef(new Set<string>());
  const declineRef = useRef<HTMLButtonElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);

  const ringMs = (c: { created_at: string; expires_at: string }) => Math.max(1000, Date.parse(c.expires_at) - Date.parse(c.created_at));
  const over = (c: { seen_ms?: number; created_at: string; expires_at: string }) => now >= (c.seen_ms ?? now) + ringMs(c);
  const ringing = calls.find((c) => c.status === "ringing" && !over(c));
  // While the voice service is down the screen still shows (so the scenario can be previewed), but silent, and Accept is off: it would only land on "Voice is offline".
  const voiceDown = voice === "down";
  const show = ringing && !isCallActive(call) ? ringing : undefined;

  // Nobody answered in time: tell the database (any phone may report it; it only works after the server's deadline, so retry until it takes).
  useEffect(() => {
    for (const c of calls) {
      if (c.status === "ringing" && over(c) && !reported.current.has(c.id)) {
        reported.current.add(c.id);
        void expireBrianCall(c.id).catch(() => reported.current.delete(c.id));
      }
    }
  }); // every tick: cheap, and a report the server rejected as too early is retried

  useEffect(() => {
    if (!show || voiceDown) return;
    return startRinging();
  }, [show?.id, voiceDown]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const decline = () => {
    if (show) void declineBrianCall(show.id).catch(() => undefined);
  };
  const accept = async () => {
    if (!show || busy || voiceDown) return;
    const { id, alert_id } = show;
    unlockCallAudio(); // inside the tap, before any await, so the browser allows sound
    setBusy(true);
    try {
      await answerBrianCall(id, me);
    } catch (e) {
      setBusy(false);
      setNotice(/already answered/i.test(String(e)) ? "Someone else in the room already answered Brian." : "That call has ended.");
      return;
    }
    setBusy(false);
    openCallSheet();
    startCall({ householdId, displayName: me, callback: { alertId: alert_id, callId: id } }, { skipExplainer: true });
  };

  // Focus lives inside the screen while it is up: Accept is focused, Tab cycles between the two buttons, Escape declines.
  useEffect(() => {
    if (!show) return;
    acceptRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        decline();
      } else if (e.key === "Tab") {
        e.preventDefault();
        (document.activeElement === acceptRef.current ? declineRef.current : acceptRef.current)?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [show?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (typeof document === "undefined") return null;
  const secondsLeft = show ? Math.max(0, Math.ceil(((show.seen_ms ?? now) + ringMs(show) - now) / 1000)) : 0;
  return createPortal(
    <>
      {show ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="incoming-title"
          aria-describedby="incoming-sub"
          className="anim-fade fixed inset-0 z-[80] flex flex-col items-center justify-between bg-[#0e1013] px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(4rem,env(safe-area-inset-top))] text-center text-white"
        >
          <div className="flex flex-col items-center">
            <p className="text-label uppercase tracking-[0.12em] text-white/60">Incoming call</p>
            <div className="relative mt-8">
              <span className="anim-rec absolute inset-0 rounded-full" aria-hidden="true" />
              <Avatar name={VOICE_NAME} size={112} />
            </div>
            <h2 id="incoming-title" className="display mt-6 text-[2rem] leading-tight">{VOICE_NAME} is calling</h2>
            <p id="incoming-sub" className="mt-2 max-w-xs text-lead text-white/80">{show.title}</p>
            {voiceDown ? <p className="mt-3 max-w-xs text-label text-white/60">Voice is offline right now, so {VOICE_NAME} can&apos;t connect. Start the voice service to answer.</p> : null}
            <p className="num mt-6 text-caption text-white/50">Ringing for everyone in the room · {secondsLeft}s</p>
          </div>
          <div className="flex w-full max-w-xs items-start justify-around">
            <button ref={declineRef} type="button" onClick={decline} className="press flex flex-col items-center gap-2 rounded-lg p-1 text-label text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-risk text-white"><IconClose size={26} /></span>
              Decline
            </button>
            <button ref={acceptRef} type="button" onClick={() => void accept()} disabled={busy || voiceDown} className="press flex flex-col items-center gap-2 rounded-lg p-1 text-label font-semibold disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
              <span className="anim-pop-in flex h-16 w-16 items-center justify-center rounded-full bg-online text-[#06220f]"><IconPhone size={26} /></span>
              Accept
            </button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="pop anim-fade fixed left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full px-4 py-2 text-label">{notice}</p>
      ) : null}
    </>,
    document.body,
  );
}
