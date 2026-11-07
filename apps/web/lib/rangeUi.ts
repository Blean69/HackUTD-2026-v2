"use client";
import { useSyncExternalStore } from "react";
import { RANGE_OPTIONS, type RangeKey } from "@/lib/finance";

/** The date-range select in the top bar. History in the data is about six months, so 12 months shows what exists. */
let current: RangeKey = "6m";
const listeners = new Set<() => void>();

export function setRange(r: RangeKey) {
  current = r;
  for (const l of listeners) l();
}
export function useRange(): { range: RangeKey; weeks: number; months: number; label: string } {
  const range = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
    () => "6m" as RangeKey,
  );
  const o = RANGE_OPTIONS.find((x) => x.value === range) ?? RANGE_OPTIONS[1];
  return { range, weeks: o.weeks, months: o.months, label: o.label };
}
