"use client";
import { useEffect } from "react";

/**
 * Connects the data layer (SpacetimeDB, or the mock engine as fallback) once per page load.
 *
 * The data layer is imported dynamically so pages that do not need it (the landing page) do not ship it in their
 * first-load JavaScript. Pages that read data import it themselves, so for them this is a no-op that just starts the
 * connection early; on the landing page it warms the connection up once the browser is idle, so the setup wizard
 * opens instantly.
 */
export function DataProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const start = () => void import("@/lib/data/runtime").then((m) => m.ensureBackend());
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(start, { timeout: 1500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(start, 300);
    return () => window.clearTimeout(t);
  }, []);
  return <>{children}</>;
}
