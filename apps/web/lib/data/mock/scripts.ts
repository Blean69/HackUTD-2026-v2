/**
 * Scripted agent runs for the mock worker. Each builder returns Steps; the engine plays them back with realistic
 * timing and turns each one into a `trace_event` row, running `effect` (a worker-only reducer in the real system)
 * as it goes. Titles and tool names follow docs/contracts.md and the planned worker tool registry.
 */
import { longDate, shortDate, usd } from "@/lib/format";
import type { Goal, Provider, ScenarioResult, TraceType, Workflow } from "@/lib/types";
import { liquidCash } from "./math";
import {
  assessGoal, extractGoals, lowPoint, monthlyOutflow, monthlySurplus, parseScenario, runScenario, screenForScam,
  totalDebtPayments, type ExtractedGoal, type SimCtx,
} from "./sim";

export const NEMO_SUPER = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
export const NEMO_NANO = "nvidia/nvidia-nemotron-nano-9b-v2";

export interface Step {
  wait: number;
  agent: string;
  type: TraceType;
  title: string;
  data?: unknown;
  model?: string;
  provider?: Provider;
  latency_ms?: number;
  tokens?: { in: number; out: number };
  effect?: () => void;
}

const jitter = (base: number, spread = 0.25) => Math.round(base * (1 - spread + Math.random() * spread * 2));

/** An LLM step answered by Nemotron on NVIDIA's API (or replayed from cache). */
function llm(agent: string, type: TraceType, title: string, o: { wait?: number; model?: string; latency?: number; tIn?: number; tOut?: number; data?: unknown; provider?: Provider; effect?: () => void } = {}): Step {
  return {
    wait: o.wait ?? 700, agent, type, title, data: o.data, effect: o.effect,
    model: o.model ?? NEMO_SUPER, provider: o.provider ?? "nvidia", latency_ms: jitter(o.latency ?? 1800),
    tokens: { in: jitter(o.tIn ?? 900), out: jitter(o.tOut ?? 160) },
  };
}

/** A deterministic tool executed by the worker. */
function tool(agent: string, type: "tool_call" | "tool_result", title: string, o: { wait?: number; latency?: number; data?: unknown; effect?: () => void } = {}): Step {
  return { wait: o.wait ?? 450, agent, type, title, data: o.data, effect: o.effect, provider: "local", latency_ms: type === "tool_result" ? jitter(o.latency ?? 40) : undefined };
}

export interface Effects {
  upsertGoal(g: Goal): void;
  addAlert(a: { severity: "info" | "warn" | "critical"; kind: "scam" | "data_quality" | "fraud" | "obligation"; title: string; detail: string }): void;
  purgeAndFinish(): void;
  setScenario(result: ScenarioResult): void;
  coachReply(text: string): void;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);

// ------------------------------------------------------------------------------------------ huddle

export function huddleScript(c: SimCtx, lines: { speaker: string; text: string }[], fx: Effects): Step[] {
  const speakers = new Set(lines.map((l) => l.speaker));
  const fullText = lines.map((l) => l.text).join(" ");
  const goals = extractGoals(lines, c);
  const low = lowPoint(c.forecast);
  const liquid = liquidCash(c.accounts);
  const scam = screenForScam(fullText);
  const hasFinanceable = goals.some((g) => g.financeable);
  const steps: Step[] = [
    { wait: 300, agent: "router", type: "run_started", title: `Table Mode ended: ${lines.length} lines from ${speakers.size} speaker${speakers.size === 1 ? "" : "s"}. Starting analysis.`, provider: "local", data: { speakers: [...speakers] } },
    llm("planner", "plan", "Plan: extract goals, check each against live balances, screen for scams, post goal cards", {
      wait: 500, latency: 2300, tIn: 1200 + lines.length * 55, tOut: 240,
      data: { steps: ["extract_goals(transcript)", "get_balances + forecast_balance", "check_feasibility(goal) for each goal", "scam_screen(transcript)", "publish goals, purge transcript"] },
    }),
    llm("goal_extractor", "thought", "Reading the conversation for commitments, amounts and dates", { wait: 600, model: NEMO_NANO, latency: 1500, tIn: 700 + lines.length * 60, tOut: 180 }),
    tool("goal_extractor", "tool_result", goals.length ? `Extracted ${goals.length} candidate goal${goals.length === 1 ? "" : "s"}: ${goals.map((g) => g.title).join("; ")}` : "No explicit goals found in this conversation", {
      wait: 400, data: goals.map((g) => ({ title: g.title, amount: g.amount, evidence_quote: g.quote })),
    }),
    tool("reconciler", "tool_call", "get_balances(household_id)", { wait: 500, data: { household_id: c.hid } }),
    tool("reconciler", "tool_result", `${c.accounts.length} accounts. Liquid cash ${usd(liquid)}; monthly surplus ${usd(monthlySurplus(c))}`, { data: { liquid, monthly_surplus: Math.round(monthlySurplus(c)) } }),
    tool("reconciler", "tool_call", "forecast_balance(days=90)", { wait: 400, data: { days: 90 } }),
    tool("reconciler", "tool_result", `Low point ${usd(low.balance)} on ${longDate(low.date)}`, { data: low }),
  ];
  for (const g of goals) steps.push(...goalSteps(g, c, fx));
  if (hasFinanceable) {
    steps.push(
      tool("reconciler", "tool_call", 'fred_rates(series="DPRIME")', { wait: 450, data: { source: "FRED (external)", series: "DPRIME" } }),
      tool("reconciler", "tool_result", "Bank prime rate 7.50%. An SBA 7(a) loan prices near prime + 2.25%", { latency: 310, data: { source: "FRED", value: 7.5 } }),
    );
  }
  steps.push(
    { wait: 500, agent: "reconciler", type: "handoff", title: "Handing the transcript to scam_guard", provider: "local" },
    tool("scam_guard", "tool_call", "scam_screen(transcript)", { wait: 450 }),
  );
  if (scam.length >= 2) {
    steps.push(
      tool("scam_guard", "tool_result", `${scam.length} scam signals: ${scam.join(", ")}`, {
        wait: 600, data: { signals: scam },
        effect: () => fx.addAlert({ severity: "critical", kind: "scam", title: "Scam Shield: this conversation matches a known scam pattern", detail: `Signals heard in Table Mode: ${scam.join(", ")}. Do not send money or gift-card numbers. Call the bank on the number printed on your card.` }),
      }),
    );
  } else {
    steps.push(tool("scam_guard", "tool_result", scam.length ? `1 weak signal (${scam[0]}); below the alert threshold` : "No scam signals in this conversation", { wait: 500, data: { signals: scam } }));
  }
  const summary = goals.length ? `${goals.length} goal${goals.length === 1 ? "" : "s"} checked against your real balances. ${goals.filter((g) => assessGoal(g, c).feasibility === "on_track").length} on track, ${goals.filter((g) => assessGoal(g, c).feasibility === "stretch").length} stretch.` : "Nothing to track this time.";
  steps.push(
    llm("reconciler", "message", summary, { wait: 700, latency: 1700, tIn: 1800, tOut: 190 }),
    { wait: 600, agent: "reconciler", type: "final", title: "Done. Goal cards posted to the room; transcript deleted (only goals and short quotes are kept).", provider: "local", data: { goals: goals.length, scam_signals: scam.length }, effect: () => fx.purgeAndFinish() },
  );
  return steps;
}

function goalSteps(g: ExtractedGoal, c: SimCtx, fx: Effects): Step[] {
  const a = assessGoal(g, c);
  const now = new Date().toISOString();
  const word = a.feasibility === "on_track" ? "on track" : a.feasibility === "stretch" ? "a stretch" : "off track";
  return [
    tool("reconciler", "tool_call", `check_feasibility("${g.title}", ${usd(g.amount)} by ${shortDate(g.date)})`, { wait: 450, data: { amount: g.amount, target_date: g.date } }),
    tool("reconciler", "tool_result", `${g.title}: ${word}. ${a.reason}`, {
      wait: 650, latency: 55, data: { feasibility: a.feasibility, reason: a.reason },
      effect: () => fx.upsertGoal({ id: `goal_${c.hid.replace("hh_", "")}_h_${slug(g.rule)}`, household_id: c.hid, title: g.title, target_amount: g.amount, target_date: g.date, priority: g.priority, feasibility: a.feasibility, evidence_quote: g.quote, source: "huddle", created_at: now, updated_at: now }),
    }),
  ];
}

// ------------------------------------------------------------------------------------------ what_if

export function whatIfScript(c: SimCtx, prompt: string, who: string, fx: Effects): Step[] {
  const parsed = parseScenario(prompt, c);
  const result = runScenario(parsed, c);
  const baseLow = lowPoint(c.forecast);
  const apr = parsed.apr;
  const steps: Step[] = [
    { wait: 300, agent: "router", type: "run_started", title: `What-if from ${who}: "${prompt.length > 70 ? `${prompt.slice(0, 67)}...` : prompt}"`, provider: "local" },
    llm("planner", "plan", "Plan: parse the scenario, project the baseline, apply the change, compare, recommend", { wait: 500, latency: 1900, tIn: 1000, tOut: 200, data: { steps: ["parse_scenario", "forecast_balance(baseline)", "apply_scenario", "compare", "recommend"] } }),
    llm("simulator", "tool_call", `parse_scenario("${prompt.length > 48 ? `${prompt.slice(0, 45)}...` : prompt}")`, { wait: 500, model: NEMO_NANO, latency: 1100, tIn: 520, tOut: 90 }),
    tool("simulator", "tool_result", `Interpreted as: ${parsed.label}`, { wait: 400, data: { kind: parsed.kind, amount: parsed.upfront, start_date: parsed.startDate, monthly: parsed.monthly } }),
    tool("simulator", "tool_call", "forecast_balance(days=90, baseline=true)", { wait: 450 }),
    tool("simulator", "tool_result", `Baseline low point ${usd(baseLow.balance)} on ${longDate(baseLow.date)}`, { data: baseLow }),
    tool("simulator", "tool_call", `apply_scenario(kind="${parsed.kind}", start="${parsed.startDate}")`, { wait: 450 }),
    tool("simulator", "tool_result", `Scenario low point ${usd(result.low_point?.balance ?? 0)} on ${longDate(result.low_point?.date ?? parsed.startDate)}`, { wait: 600, latency: 70, data: { low_point: result.low_point } }),
  ];
  if (apr !== undefined) {
    steps.push(
      tool("simulator", "tool_call", 'fred_rates(series="MORTGAGE30US,DPRIME")', { wait: 400, data: { source: "FRED (external)" } }),
      tool("simulator", "tool_result", `Prime 7.50%; using ${apr}% for this ${parsed.kind === "new_loan" ? "SBA-style" : "consumer"} loan`, { latency: 290 }),
    );
  }
  steps.push(
    llm("simulator", "thought", "Comparing against the 90-day forecast and your emergency buffer", { wait: 600, latency: 1700, tIn: 1300, tOut: 220 }),
    { wait: 500, agent: "simulator", type: "final", title: result.summary ?? "Scenario complete", provider: "nvidia", model: NEMO_SUPER, latency_ms: jitter(1400), tokens: { in: jitter(1500), out: jitter(260) }, data: { verdict: result.verdict }, effect: () => fx.setScenario(result) },
  );
  return steps;
}

// ------------------------------------------------------------------------------------------ coach

export function coachScript(c: SimCtx, question: string, who: string, fx: Effects): Step[] {
  const q = question.toLowerCase();
  const steps: Step[] = [
    { wait: 300, agent: "router", type: "run_started", title: `Coach question from ${who}: "${question.length > 70 ? `${question.slice(0, 67)}...` : question}"`, provider: "local" },
  ];
  let answer = "";
  if (/afford|can we|should we|buy|car|van|location|open|loan|raise/.test(q) && !/pay off|payoff/.test(q)) {
    const parsed = parseScenario(question, c);
    const r = runScenario(parsed, c);
    steps.push(
      llm("coach", "plan", "Plan: simulate the purchase against the real forecast, then answer plainly", { wait: 500, latency: 1500, tIn: 800, tOut: 150 }),
      tool("coach", "tool_call", `simulate_scenario(kind="${parsed.kind}", start="${parsed.startDate}")`, { wait: 500 }),
      tool("coach", "tool_result", `Lowest checking balance becomes ${usd(r.low_point?.balance ?? 0)} on ${shortDate(r.low_point?.date ?? parsed.startDate)}`, { wait: 700, data: r.metrics }),
    );
    answer = `${r.summary} ${r.suggestion ?? ""}`.trim();
  } else if (/pay off|payoff|visa|card|debt|interest|owe/.test(q)) {
    const debts = c.accounts.filter((a) => a.type === "credit_card" || a.type === "personal_loan" || a.type === "auto_loan").sort((a, b) => (b.rate_pct ?? 0) - (a.rate_pct ?? 0));
    const top = debts[0];
    steps.push(
      llm("coach", "plan", "Plan: list debts by interest rate, then rank a payoff order", { wait: 500, latency: 1400, tIn: 760, tOut: 140 }),
      tool("coach", "tool_call", "get_accounts(household_id, types=[credit_card, loans])", { wait: 450 }),
      tool("coach", "tool_result", `${debts.length} debts; highest rate ${top?.rate_pct ?? 0}% on ${top?.nickname ?? "n/a"}`, { data: debts.map((d) => ({ name: d.nickname, balance: d.balance, apr: d.rate_pct })) }),
      tool("coach", "tool_call", "payoff_plan(strategy=\"avalanche\")", { wait: 500 }),
      tool("coach", "tool_result", `Avalanche order: ${debts.slice(0, 3).map((d) => d.nickname).join(" > ")}`, { wait: 600 }),
    );
    answer = top
      ? `Pay ${top.nickname} first: ${usd(top.balance)} at ${top.rate_pct}% APR costs about ${usd(Math.round((top.balance * (top.rate_pct ?? 0)) / 1200))} a month in interest. Order by rate: ${debts.slice(0, 3).map((d) => `${d.nickname} (${d.rate_pct}%)`).join(", ")}. You can cover it from savings and still keep ${usd(Math.max(0, liquidCash(c.accounts) - top.balance))} in cash.`
      : "You have no card or loan balances to pay down. Nice work.";
  } else if (/emergency|rainy|runway|cushion|safe|savings/.test(q) && !/scam/.test(q)) {
    const rw = c.health.find((h) => h.key === "liquidity_runway");
    const ef = c.health.find((h) => h.key === "emergency_fund");
    steps.push(
      llm("coach", "plan", "Plan: read the health indicators, explain what is weak and what to do", { wait: 500, latency: 1300, tIn: 700, tOut: 120 }),
      tool("coach", "tool_call", "get_health_indicators(household_id)", { wait: 450 }),
      tool("coach", "tool_result", `Runway ${rw?.value ?? "?"} mo (${rw?.status}); emergency fund ${ef?.value ?? "?"} mo (${ef?.status})`, { wait: 600, data: c.health.map((h) => ({ key: h.key, value: h.value, status: h.status })) }),
    );
    answer = `Cash runway is ${rw?.value.toFixed(1)} months and your emergency fund covers ${ef?.value.toFixed(1)}. To reach a 6-month cushion you would add about ${usd(Math.max(0, Math.round((monthlyOutflow(c) * 0.75 * 6) - (ef?.value ?? 0) * monthlyOutflow(c) * 0.75)))}. At today's ${usd(Math.max(0, monthlySurplus(c)))}/mo surplus, automating a transfer on payday is the simplest first step.`;
  } else if (/scam|fraud|suspicious|phish|steal|stolen/.test(q)) {
    const open = c.alerts.filter((a) => !a.acknowledged_by);
    steps.push(
      llm("coach", "plan", "Plan: pull open alerts, scan recent transactions for scam patterns", { wait: 500, latency: 1300, tIn: 720, tOut: 130 }),
      tool("coach", "tool_call", "get_alerts(household_id, open=true)", { wait: 450 }),
      tool("coach", "tool_result", `${open.length} open alert${open.length === 1 ? "" : "s"}`, { data: open.map((a) => ({ severity: a.severity, title: a.title })) }),
      tool("coach", "tool_call", "scan_transactions(detectors=[card_testing, scam_payment, account_takeover])", { wait: 550 }),
      tool("coach", "tool_result", `${open.filter((a) => a.kind === "fraud" || a.kind === "scam").length} fraud/scam finding(s)`, { wait: 700, latency: 120 }),
    );
    const f = open.filter((a) => a.kind === "fraud" || a.kind === "scam");
    answer = f.length ? `Yes, ${f.length === 1 ? "one thing needs attention" : `${f.length} things need attention`}: ${f.map((a) => a.title).join("; ")}. Acknowledge the alert once you have called the bank.` : "Nothing suspicious right now. I checked card-testing, scam-payment and account-takeover patterns across recent transactions.";
  } else {
    const goals = c.goals;
    steps.push(
      llm("coach", "plan", "Plan: summarise health, goals and the next 90 days", { wait: 500, latency: 1400, tIn: 760, tOut: 140 }),
      tool("coach", "tool_call", "get_health_indicators(household_id)", { wait: 450 }),
      tool("coach", "tool_result", `${c.health.filter((h) => h.status === "risk").length} at risk, ${c.health.filter((h) => h.status === "watch").length} to watch`, { wait: 500 }),
      tool("coach", "tool_call", "get_goals(household_id)", { wait: 400 }),
      tool("coach", "tool_result", `${goals.length} goal${goals.length === 1 ? "" : "s"} on the board`, { wait: 400 }),
    );
    const risk = c.health.find((h) => h.status === "risk") ?? c.health.find((h) => h.status === "watch");
    answer = `Biggest thing to fix: ${risk?.label.toLowerCase() ?? "nothing urgent"}. ${risk?.explanation ?? ""} You have ${goals.length} goal${goals.length === 1 ? "" : "s"} tracked, and ${usd(Math.max(0, monthlySurplus(c)))}/mo of surplus to work with. Debt payments total ${usd(totalDebtPayments(c))}/mo.`;
  }
  steps.push(llm("coach", "final", "Answer ready", { wait: 700, latency: 1600, tIn: 1400, tOut: 200, effect: () => fx.coachReply(answer) }));
  return steps;
}

// ------------------------------------------------------------------------------------------ ambient + others

export function dataQualityScript(c: SimCtx, fx: Effects, label = "New sandbox"): Step[] {
  return [
    { wait: 300, agent: "router", type: "run_started", title: `${label}: data-quality sweep over ${c.accounts.length} accounts`, provider: "local" },
    llm("planner", "plan", "Plan: scan transactions for duplicates, garbled merchants and impossible values", { wait: 500, latency: 1500, tIn: 900, tOut: 160 }),
    tool("data_auditor", "tool_call", "scan_transactions(detectors=[duplicate, garbled, impossible_value])", { wait: 500 }),
    tool("data_auditor", "tool_result", "2 duplicate postings and 2 unreadable merchants found", { wait: 800, latency: 140 }),
    llm("data_auditor", "thought", "Merging duplicates would change the balance by under $200; flag instead of auto-fixing", { wait: 600, model: NEMO_NANO, latency: 1100, tIn: 600, tOut: 100 }),
    { wait: 500, agent: "data_auditor", type: "final", title: "Flagged for review; nothing was changed automatically", provider: "nvidia", model: NEMO_NANO, latency_ms: jitter(900), tokens: { in: 500, out: 70 }, effect: () => fx.addAlert({ severity: "info", kind: "data_quality", title: "Data check: 2 possible duplicate postings", detail: "The auditor found two transactions that look double-posted. Review them before relying on balances." }) },
  ];
}

export function ambientScript(workflow: Workflow, cached: boolean): Step[] {
  const p: Provider = cached ? "cache" : "nvidia";
  const mk = (agent: string, type: TraceType, title: string, wait: number, model?: string): Step => ({
    wait, agent, type, title, provider: model ? p : "local", model: model ? (cached ? model : model) : undefined,
    latency_ms: model ? (cached ? jitter(40, 0.3) : jitter(1500)) : jitter(60), tokens: model ? { in: jitter(900), out: jitter(150) } : undefined,
  });
  switch (workflow) {
    case "huddle":
      return [mk("router", "run_started", "Table Mode ended: 9 lines from 3 speakers", 200), mk("planner", "plan", "Plan: extract goals, reconcile with ledger, scam screen", 700, NEMO_SUPER), mk("goal_extractor", "tool_result", "Extracted 3 candidate goals", 800, NEMO_NANO), mk("reconciler", "tool_call", "get_balances(household_id)", 500), mk("reconciler", "tool_result", "5 accounts; liquid cash $41,200", 500), mk("reconciler", "tool_result", "College fund: on track", 900), mk("scam_guard", "tool_result", "No scam signals", 700), mk("reconciler", "final", "Done. 3 goals posted, transcript deleted", 700, NEMO_SUPER)];
    case "what_if":
      return [mk("router", "run_started", "What-if: \"refinance the car loan\"", 200), mk("planner", "plan", "Plan: parse, project baseline, apply, compare", 700, NEMO_SUPER), mk("simulator", "tool_call", "forecast_balance(days=90)", 500), mk("simulator", "tool_result", "Low point $6,120", 600), mk("simulator", "tool_call", "apply_scenario(kind=\"rate_change\")", 500), mk("simulator", "final", "Saves $38/mo; low point unchanged", 900, NEMO_SUPER)];
    case "coach":
      return [mk("router", "run_started", "Coach question: \"Are we saving enough?\"", 200), mk("coach", "plan", "Plan: read savings rate and goals", 700, NEMO_SUPER), mk("coach", "tool_call", "get_health_indicators(household_id)", 500), mk("coach", "tool_result", "Savings rate 11% (watch)", 500), mk("coach", "final", "Answer ready", 900, NEMO_SUPER)];
    case "scam_check":
      return [mk("router", "run_started", "Scam check: Zelle payment of $950 to a new payee", 200), mk("scam_guard", "plan", "Plan: payee age, amount vs history, caller context", 700, NEMO_SUPER), mk("scam_guard", "tool_call", "payee_history(payee_id)", 500), mk("scam_guard", "tool_result", "New payee; first payment; 4.2x usual amount", 600), mk("scam_guard", "tool_call", "match_known_patterns()", 500), mk("scam_guard", "tool_result", "Matches tech-support scam (3 signals)", 600), mk("scam_guard", "final", "Alert raised: hold payment and call customer", 800, NEMO_SUPER)];
    case "plaid_sync":
      return [mk("router", "run_started", "Bank sync: First Platypus Bank", 200), mk("planner", "plan", "Plan: accounts, liabilities, transactions, map types", 700, NEMO_SUPER), mk("plaid_sync", "tool_call", "plaid.transactions_sync()", 500), mk("plaid_sync", "tool_result", "92 added", 700), mk("plaid_sync", "final", "Synced and recomputed", 800)];
    default:
      return [mk("router", "run_started", "Data-quality sweep over 7 accounts", 200), mk("planner", "plan", "Plan: duplicates, garbled merchants, impossible values", 700, NEMO_SUPER), mk("data_auditor", "tool_call", "scan_transactions()", 500), mk("data_auditor", "tool_result", "3 anomalies", 700), mk("data_auditor", "final", "Flagged for review", 800, NEMO_NANO)];
  }
}

export function plaidSyncScript(c: SimCtx, institution: string, fx: { done(): void }): Step[] {
  return [
    { wait: 300, agent: "router", type: "run_started", title: `Bank sync: ${institution} for household ${c.hid}`, provider: "local" },
    llm("planner", "plan", "Plan: fetch accounts, balances, liabilities and new transactions, map types, recompute", { wait: 500, latency: 1600, tIn: 900, tOut: 170, data: { steps: ["accounts/get + balances", "liabilities/get", "transactions/sync", "map Plaid types to our 8 account types", "recompute_household + data_quality"] } }),
    tool("plaid_sync", "tool_call", "plaid.accounts_balance_get(item)", { wait: 500, data: { source: "Plaid Sandbox (external)" } }),
    tool("plaid_sync", "tool_result", "2 accounts: Plaid Checking, Plaid Saving", { wait: 600, latency: 410 }),
    tool("plaid_sync", "tool_call", "plaid.transactions_sync(cursor=null)", { wait: 500 }),
    tool("plaid_sync", "tool_result", "184 added, 0 modified, 0 removed", { wait: 700, latency: 620 }),
    llm("plaid_sync", "thought", "Plaid subtype \"cd\" maps to our cd; \"money market\" maps to savings", { wait: 500, model: NEMO_NANO, latency: 900, tIn: 480, tOut: 70 }),
    { wait: 500, agent: "plaid_sync", type: "final", title: "Synced. Accounts and transactions upserted; forecast recomputed", provider: "local", effect: () => fx.done() },
  ];
}
