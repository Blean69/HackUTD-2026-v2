/**
 * Parsing for `credit_score.factors_json` (contracts.md section 9). Kept apart from lib/finance-credit.ts because the
 * SpacetimeDB row mappers (loaded on every page) need it, and the rest of the credit math only on the pages that show it.
 */
import type { CreditFactor } from "@/lib/types";

const SPAN = 550;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** The weights in the contract, in the order the UI lists them. */
export const FACTOR_META: { key: string; label: string; weight: number }[] = [
  { key: "household_health", label: "Household finances", weight: 0.45 },
  { key: "payment_history", label: "Payment history", weight: 0.2 },
  { key: "utilization", label: "Card utilization", weight: 0.15 },
  { key: "history_length", label: "Credit history length", weight: 0.08 },
  { key: "new_credit", label: "New credit", weight: 0.06 },
  { key: "credit_mix", label: "Credit mix", weight: 0.06 },
];

const KEY_ALIAS: Record<string, string> = {
  health: "household_health", household: "household_health", household_health: "household_health", financial_health: "household_health",
  payment: "payment_history", payments: "payment_history", payment_history: "payment_history", late_payments: "payment_history",
  utilization: "utilization", credit_utilization: "utilization", util: "utilization",
  history: "history_length", history_length: "history_length", length: "history_length", credit_age: "history_length", age: "history_length",
  new_credit: "new_credit", inquiries: "new_credit", hard_inquiries: "new_credit",
  mix: "credit_mix", credit_mix: "credit_mix",
};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * `credit_score.factors_json`, parsed. The contract fixes the content (value, weight, points, one-line explanation per
 * factor) but not the exact shape, so this accepts an array of objects or an object keyed by factor, weights as 0.45 or
 * 45, and fills `points` from the weight and value when it is missing.
 */
export function parseFactors(raw: unknown): CreditFactor[] {
  const entries: [string | undefined, Record<string, unknown>][] = [];
  const src = raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { factors?: unknown }).factors) ? (raw as { factors: unknown[] }).factors : raw;
  if (Array.isArray(src)) for (const x of src) if (x && typeof x === "object") entries.push([undefined, x as Record<string, unknown>]);
  if (src && typeof src === "object" && !Array.isArray(src)) for (const [k, x] of Object.entries(src)) if (x && typeof x === "object") entries.push([k, x as Record<string, unknown>]);
  const out: CreditFactor[] = [];
  for (const [k, x] of entries) {
    const rawKey = (k ?? str(x.key) ?? str(x.factor) ?? str(x.name) ?? str(x.id) ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    const key = KEY_ALIAS[rawKey] ?? rawKey;
    const meta = FACTOR_META.find((m) => m.key === key);
    let weight = num(x.weight) ?? meta?.weight ?? 0;
    if (weight > 1) weight /= 100;
    let value = num(x.value) ?? num(x.score) ?? num(x.factor_value);
    if (value !== undefined && value > 1) value /= 100;
    const max = SPAN * weight;
    const points = num(x.points) ?? (value !== undefined ? max * value : 0);
    if (value === undefined) value = max ? points / max : 0;
    out.push({
      key: key || `factor_${out.length}`,
      label: str(x.label) ?? meta?.label ?? (rawKey ? rawKey.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Factor"),
      weight, value: clamp01(value), points, max_points: max,
      explanation: str(x.explanation) ?? str(x.why) ?? str(x.reason) ?? str(x.text) ?? str(x.detail) ?? "",
    });
  }
  const order = (f: CreditFactor) => {
    const i = FACTOR_META.findIndex((m) => m.key === f.key);
    return i < 0 ? 99 : i;
  };
  return out.sort((a, b) => order(a) - order(b) || b.weight - a.weight);
}

