"use client";
import { useEffect } from "react";
import { ensureBackend } from "@/lib/data/runtime";

/** Connects the data layer (SpacetimeDB, or the mock engine as fallback) once per page load. */
export function DataProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void ensureBackend();
  }, []);
  return <>{children}</>;
}
