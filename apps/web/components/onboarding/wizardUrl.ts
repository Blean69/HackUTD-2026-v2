"use client";
/**
 * The wizard keeps its position in the URL (`?step=connect`, `?step=questions&q=2`), so a refresh resumes where you
 * were and the browser's Back button walks back through the steps.
 *
 * Read with useSyncExternalStore (server snapshot ""), so /onboarding still prerenders its first screen as static
 * HTML. Written with history.pushState / replaceState, which the Next.js router picks up without a navigation.
 */
import { useSyncExternalStore } from "react";
import { stepIndex, STEPS, type StepKey } from "@/lib/data/onboarding";

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("popstate", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("popstate", cb);
  };
}

const read = () => window.location.search;

export interface WizardPos {
  step: StepKey | null;
  q: number;
}

export function parsePos(search: string): WizardPos {
  const p = new URLSearchParams(search);
  const raw = p.get("step");
  const step = raw && stepIndex(raw) >= 0 ? (raw as StepKey) : null;
  const q = Math.max(1, Math.min(3, parseInt(p.get("q") ?? "1", 10) || 1));
  return { step, q };
}

export function useWizardPos(): WizardPos {
  const search = useSyncExternalStore(subscribe, read, () => "");
  return parsePos(search);
}

function urlFor(pos: { step: StepKey; q?: number }, pathname = window.location.pathname): string {
  const p = new URLSearchParams(window.location.search);
  p.set("step", pos.step);
  if (pos.step === "questions" && pos.q && pos.q > 1) p.set("q", String(pos.q));
  else p.delete("q");
  return `${pathname}?${p.toString()}`;
}

/** Forward: a new history entry, so the browser's Back returns here. */
export function pushPos(pos: { step: StepKey; q?: number }): void {
  window.history.pushState({ wizardFrom: window.location.search }, "", urlFor(pos));
  emit();
}

/** Back: pop our own entry when it is the one we came from, otherwise replace (deep links, refreshes). */
export function backTo(pos: { step: StepKey; q?: number }): void {
  const target = new URL(urlFor(pos), window.location.origin).search;
  const state = window.history.state as { wizardFrom?: string } | null;
  if (state?.wizardFrom === target) {
    window.history.back();
    return;
  }
  window.history.replaceState(null, "", urlFor(pos));
  emit();
}

/** Correct the URL without adding history (clamping to a step that is possible right now). */
export function replacePos(pos: { step: StepKey; q?: number }): void {
  window.history.replaceState(window.history.state, "", urlFor(pos));
  emit();
}

/** Re-read the URL after a router navigation (household created: /onboarding -> /onboarding/[id]). */
export const syncPos = emit;

export const STEP_KEYS = STEPS.map((s) => s.key) as StepKey[];
