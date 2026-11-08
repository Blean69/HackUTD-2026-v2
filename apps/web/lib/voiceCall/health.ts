"use client";
import { useSyncExternalStore } from "react";
import { VOICE_URL } from "@/lib/constants";

/**
 * Availability of the voice service (`GET {VOICE_URL}/health`).
 *
 *   checking  first probe in flight; the UI treats this like "up" so buttons never flash disabled on page load
 *   up        the service answered
 *   down      no answer, a non-2xx answer, or a timeout; the call buttons render disabled with a tooltip
 *
 * Probes run on demand (opening the call sheet, starting a call) and every 15 s while something on screen is watching.
 */
export type VoiceStatus = "checking" | "up" | "down";

const POLL_MS = 15_000;
const FRESH_MS = 4_000;

let status: VoiceStatus = "checking";
let demoCall = false; // whether the voice service can ring the demo phone (/health says; never the number)
let callbackWeb = true; // the voice service's VOICE_CALLBACK_WEB flag, learned from /health (true until it says otherwise)
let checkedAt = 0;
let inflight: Promise<VoiceStatus> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function set(next: VoiceStatus) {
  checkedAt = Date.now();
  if (next === status) return;
  status = next;
  for (const l of listeners) l();
}

async function probe(timeoutMs: number): Promise<VoiceStatus> {
  const url = `${VOICE_URL}/health`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { callback_web?: boolean; demo_call?: boolean } | null;
      callbackWeb = body?.callback_web !== false;
      demoCall = body?.demo_call === true;
    }
    return res.ok ? "up" : "down";
  } catch {
    if (ctl.signal.aborted) return "down";
    // A TypeError is either "nothing is listening" or "the service answered but did not send CORS headers".
    // A no-cors request tells the two apart: it resolves (opaque) only when something answered.
    try {
      await fetch(url, { mode: "no-cors", signal: ctl.signal, cache: "no-store" });
      return "up";
    } catch {
      return "down";
    }
  } finally {
    clearTimeout(t);
  }
}

/** Probe the voice service now (shared between callers). `force` skips the few-seconds-old cached answer. */
export function checkVoice(force = false, timeoutMs = 2500): Promise<VoiceStatus> {
  if (!force && status !== "checking" && Date.now() - checkedAt < FRESH_MS) return Promise.resolve(status);
  if (inflight) return inflight;
  inflight = probe(timeoutMs)
    .then((s) => {
      set(s);
      return s;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Whether "try a call" rings the demo phone (DEMO_PHONE set on the voice service). */
export function getDemoCall(): boolean {
  return demoCall;
}

/** Whether Brian rings back inside the app after a call (the voice service decides). */
export function getCallbackWeb(): boolean {
  return callbackWeb;
}

export function getVoiceStatus(): VoiceStatus {
  return status;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) {
    void checkVoice(true);
    timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void checkVoice(true);
    }, POLL_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useVoiceStatus(): VoiceStatus {
  return useSyncExternalStore(subscribe, () => status, () => "checking" as const);
}
