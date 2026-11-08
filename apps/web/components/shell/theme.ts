"use client";
import { useSyncExternalStore } from "react";
import { THEME_COLOR, THEME_KEY, type Theme, type ThemePref } from "./theme-script";

/** Light / dark theme, client half: the toggle calls setThemePref(); components read useThemePref() / useTheme(). */
export type { Theme, ThemePref };

const listeners = new Set<() => void>();

function readPref(): ThemePref {
  if (typeof document === "undefined") return "system";
  const p = document.documentElement.getAttribute("data-theme-pref");
  return p === "light" || p === "dark" ? p : "system";
}
function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function setThemePref(p: ThemePref): void {
  try {
    if (p === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, p);
  } catch {
    /* private mode: still apply for this page */
  }
  const root = document.documentElement;
  // Swap every token at once instead of letting each element's colour transition run.
  root.classList.add("theme-switching");
  // Stamp directly (works even when storage is blocked), then keep the browser chrome colour in step.
  const t: Theme = p === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p;
  root.setAttribute("data-theme", t);
  root.setAttribute("data-theme-pref", p);
  root.style.colorScheme = t;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", THEME_COLOR[t]));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // The OS can flip the resolved theme while the preference is "system".
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => requestAnimationFrame(cb);
  mq.addEventListener?.("change", onChange);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener?.("change", onChange);
  };
}

/** The stored preference ("system" on the server and before hydration). */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, readPref, () => "system");
}

/** The resolved theme ("light" on the server). Charts that need a literal colour can read it. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => "light");
}
