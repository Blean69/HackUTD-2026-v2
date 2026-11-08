"use client";
import { useSyncExternalStore } from "react";

/**
 * Remembered voice preferences, shared by Table Mode and the Talk call (one noisy room, one setting).
 *
 *   pushToTalk   "Noisy room? Hold to talk". Off by default.
 *   halfDuplex   Speakerphone guard: the mic is muted while Brian speaks. Default ON for phones (coarse primary pointer or a
 *                viewport <= 640 px) and OFF elsewhere, until the person chooses; their choice then sticks.
 *
 * localStorage can throw (private mode, blocked site data) or be empty, so every access is wrapped and the in-memory value
 * keeps working for the page's lifetime.
 */

export interface VoicePrefs {
  pushToTalk: boolean;
  halfDuplex: boolean;
}

const PTT_KEY = "keystone.voice.pushToTalk";
const HALF_DUPLEX_KEY = "keystone.voice.halfDuplex";

/** What the server and the first client render see (no localStorage, no matchMedia). */
export const SERVER_PREFS: VoicePrefs = { pushToTalk: false, halfDuplex: false };

let prefs: VoicePrefs | null = null;
const listeners = new Set<() => void>();
let storageHooked = false;

function read(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}
function write(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* private mode / quota: keep the in-memory value */
  }
}

/** A phone-like device: touch is the primary input, or the screen is narrow. */
export function isPhoneLike(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 640px)").matches;
  } catch {
    return false;
  }
}

function load(): VoicePrefs {
  return { pushToTalk: read(PTT_KEY) === true, halfDuplex: read(HALF_DUPLEX_KEY) ?? isPhoneLike() };
}

export function getVoicePrefs(): VoicePrefs {
  if (typeof window === "undefined") return SERVER_PREFS;
  prefs ??= load();
  return prefs;
}

function emit() {
  for (const l of listeners) l();
}

function patch(next: Partial<VoicePrefs>) {
  const cur = getVoicePrefs();
  const merged = { ...cur, ...next };
  if (merged.pushToTalk === cur.pushToTalk && merged.halfDuplex === cur.halfDuplex) return;
  prefs = merged; // new object: useSyncExternalStore compares snapshots by identity
  emit();
}

export function setPushToTalkPref(on: boolean) {
  write(PTT_KEY, on);
  patch({ pushToTalk: on });
}

export function setHalfDuplexPref(on: boolean) {
  write(HALF_DUPLEX_KEY, on);
  patch({ halfDuplex: on });
}

export function subscribeVoicePrefs(cb: () => void): () => void {
  listeners.add(cb);
  if (!storageHooked && typeof window !== "undefined") {
    storageHooked = true;
    // Another tab changed the setting.
    window.addEventListener("storage", (e) => {
      if (e.key !== null && e.key !== PTT_KEY && e.key !== HALF_DUPLEX_KEY) return;
      prefs = load();
      emit();
    });
  }
  return () => {
    listeners.delete(cb);
  };
}

/** `{ pushToTalk, halfDuplex }`, usable before any call or capture exists (e.g. to render the "Noisy room?" toggle). */
export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(subscribeVoicePrefs, getVoicePrefs, () => SERVER_PREFS);
}
