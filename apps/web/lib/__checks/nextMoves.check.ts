// Run: npx tsx lib/__checks/nextMoves.check.ts  (Rivera numbers from the local database, 2026-11-08)
import assert from "node:assert/strict";
import { nextMoves } from "../nextMoves";
import type { Account, HealthIndicator } from "../types";

const h = (key: string, value: number, unit: string, status: string) => ({ id: key, household_id: "hh", key, label: key, value, unit, status, explanation: "", updated_at: "" }) as unknown as HealthIndicator;
const health = [
  h("liquidity_runway", 3.3, "months", "watch"), h("debt_to_income", 20.5, "pct", "good"), h("credit_utilization", 15.7, "pct", "good"),
  h("savings_rate", 8.8, "pct", "watch"), h("net_worth_trend", 11972, "usd", "good"), h("emergency_fund", 97.7, "pct", "watch"),
  h("forecast_low_point", 39654, "usd", "good"), h("credit_score", 726, "score", "watch"),
];
const acct = (type: string, balance: number) => ({ id: type, household_id: "hh", type, institution: "", nickname: type, balance, opened_date: "", owner_member_ids: [] }) as unknown as Account;
const moves = nextMoves({ health, accounts: [acct("checking", 4000), acct("savings", 36109)], obligations: [], incomeMonthly: 13362, spendMonthly: 12185 });
console.log(moves.map((m) => `${m.title} | ${m.detail} | ${m.why} | +${m.lift} → ${m.scoreAfter}`).join("\n"));
assert.ok(moves.length >= 2, "watch indicators produce moves");
assert.equal(moves[0].key, "cushion", "the thin cushion ranks first");
assert.ok(moves.every((m, i) => m.lift > 0 && (i === 0 || moves[i - 1].lift >= m.lift)), "ranked by positive lift");
assert.equal(nextMoves({ health: health.map((x) => ({ ...x, status: "good" as const })), accounts: [], obligations: [], incomeMonthly: 1, spendMonthly: 1 }).length, 0, "all good → no moves");
console.log("ok");
