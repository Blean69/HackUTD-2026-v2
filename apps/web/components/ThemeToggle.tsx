"use client";
import { useSyncExternalStore } from "react";
import { IconMoon, IconSun } from "./icons";

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}
const get = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, get, () => "light");
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("keystone.theme", next);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {theme === "dark" ? <IconSun size={19} /> : <IconMoon size={19} />}
    </button>
  );
}
