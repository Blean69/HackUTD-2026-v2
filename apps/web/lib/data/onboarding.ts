"use client";
/**
 * Onboarding data layer (docs/contracts.md section 7).
 *
 * Two interchangeable implementations behind one set of hooks and actions:
 *
 * - live: the reducers `start_onboarding`, `save_onboarding_answers`, `select_bank_accounts`, `finish_onboarding`,
 *   the tables `household_profile` and `bank_account_option`, and the worker's Plaid routes (`select: true`).
 *   Used when the connected module publishes all of them.
 * - mock: an in-browser stand-in for the module and the worker that writes into the same shared store the dashboard
 *   reads, so the whole flow (and the dashboard it ends on) works with no backend at all.
 *
 * `household_profile` and `bank_account_option` are not in the shared store; they live in two small tables here,
 * fed by the live connection (lib/data/spacetime.ts exposes it through `liveConnection()`). Everything else
 * (household, member, account, goal, alert, bank_connection, agent_run, trace_event, presence) comes from the shared
 * store through the ordinary hooks, so the same screens work in both modes.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { WORKER_URL } from "@/lib/constants";
import { workerPost } from "@/lib/worker";
import type {
  Account, AccountType, AgentRun, Alert, AlertKind, Goal, Household, MemberRole, Obligation, TraceEvent, TraceType, Transaction, Workflow,
} from "@/lib/types";
import { getConnection, useConnection } from "./connection";
import { useBankConnections, useRows, useTraceEvents } from "./hooks";
import { computeForecast, computeHealth, isoDate } from "./mock/math";
import { ensureBackend } from "./runtime";
import { liveConnection } from "./spacetime";
import { emptyRows, store } from "./store";

// ------------------------------------------------------------------------------------------------ vocabulary

export const STEPS = [
  { key: "welcome", label: "Welcome" },
  { key: "household", label: "Your household" },
  { key: "connect", label: "Connect your bank" },
  { key: "accounts", label: "Choose accounts" },
  { key: "questions", label: "A few questions" },
  { key: "done", label: "Done" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export const STEP_COUNT = STEPS.length;
export const stepIndex = (k: string): number => STEPS.findIndex((s) => s.key === k);
/** The "A few questions" step is three short screens. */
export const QUESTION_COUNT = 3;

export const INSIGHTS_WORKFLOW = "onboarding_insights";
export const MAX_PRIORITIES = 3;

/** Keys and goal titles match spacetime/src/reducers/onboarding.ts, so the mock and the module write the same goals. */
export const PRIORITIES: { key: string; label: string; goal: string }[] = [
  { key: "emergency_fund", label: "Emergency fund", goal: "Build an emergency fund" },
  { key: "home", label: "Buy a home", goal: "Save for a home" },
  { key: "college", label: "College savings", goal: "Save for college" },
  { key: "retirement", label: "Retirement", goal: "Boost retirement savings" },
  { key: "debt_payoff", label: "Pay off debt", goal: "Pay off debt" },
  { key: "travel", label: "Travel", goal: "Save for travel" },
  { key: "business", label: "Start or grow a business", goal: "Start or grow a business" },
  { key: "caring_for_parents", label: "Caring for parents", goal: "Support the care of parents" },
];
export const GOAL_TEXT_MAX = 140;

export const RISK_LEVELS: { value: number; label: string; hint: string }[] = [
  { value: 1, label: "Safety first", hint: "I would rather earn less than see my savings drop." },
  { value: 2, label: "Mostly cautious", hint: "Small ups and downs are fine, big ones are not." },
  { value: 3, label: "Balanced", hint: "I can ride out some bumps for better long-term growth." },
  { value: 4, label: "Growth-minded", hint: "I am comfortable with real swings for a bigger payoff." },
  { value: 5, label: "Bold", hint: "I focus on the long run and can stomach big drops." },
];

export const ROLES: { value: MemberRole; label: string }[] = [
  { value: "parent", label: "Parent" },
  { value: "child", label: "Child" },
  { value: "grandparent", label: "Grandparent" },
  { value: "other", label: "Other" },
];

// ------------------------------------------------------------------------------------------------ types

export type OnboardingStatus = "welcome" | "connect" | "selecting" | "questions" | "done";
export type OnboardingBankStatus = "linking" | "selecting" | "syncing" | "ok" | "error";

export interface AnswerMember {
  /** Present for people who already exist (the module matches on it, else on name). */
  id?: string;
  name: string;
  role: MemberRole;
  age: number;
  income_annual: number;
}
/** `save_onboarding_answers.answers_json` (keys as read by spacetime/src/reducers/onboarding.ts). */
export interface OnboardingAnswers {
  members: AnswerMember[];
  own_home: boolean;
  home_value: number;
  vehicle_value: number;
  /** Keys from PRIORITIES, most important first, at most MAX_PRIORITIES. */
  priorities: string[];
  /** Free-text goal, up to GOAL_TEXT_MAX characters. */
  goal_text: string;
  /** 1 (safety first) to 5 (bold). */
  risk_comfort: number;
  voting_enabled: boolean;
  voice_consent: boolean;
}
export const defaultAnswers = (name: string): OnboardingAnswers => ({
  members: [{ name, role: "parent", age: 0, income_annual: 0 }],
  own_home: false,
  home_value: 0,
  vehicle_value: 0,
  priorities: [],
  goal_text: "",
  risk_comfort: 3,
  voting_enabled: true,
  voice_consent: false,
});

export interface HouseholdProfile {
  household_id: string;
  status: OnboardingStatus;
  answers: Partial<OnboardingAnswers> | null;
  risk_comfort: number;
  priorities: string[];
  voting_enabled: boolean;
  voice_consent: boolean;
  created_at: string;
  updated_at: string;
}

export interface AccountOption {
  id: string;
  household_id: string;
  item_id: string;
  account_id: string;
  name: string;
  official_name: string;
  mask: string;
  type: string;
  subtype: string;
  balance: number;
  selected: boolean;
}

/** `bank_connection`, with the extra "selecting" status that onboarding adds. */
export interface OnboardingBank {
  item_id: string;
  household_id: string;
  institution_name: string;
  status: OnboardingBankStatus;
  accounts_count: number;
  txns_count: number;
  last_synced_at?: string;
  error?: string;
}

export interface AccountKind {
  type: AccountType;
  label: string;
  /** True when the balance is money owed. */
  debt: boolean;
}
/** Plaid type/subtype (or one of our account types) to a friendly label and one of our 8 account types. */
export function accountKind(o: { type: string; subtype: string }): AccountKind {
  const t = `${o.type} ${o.subtype}`.toLowerCase().replace(/_/g, " ");
  if (/mortgage/.test(t)) return { type: "mortgage", label: "Mortgage", debt: true };
  if (/\bauto\b|\bvehicle\b/.test(t)) return { type: "auto_loan", label: "Auto loan", debt: true };
  if (/credit/.test(t)) return { type: "credit_card", label: "Credit card", debt: true };
  if (/student|loan|line of credit|home equity|personal/.test(t)) return { type: "personal_loan", label: "Loan", debt: true };
  if (/\bira\b|401|403|roth|retire|pension|investment|brokerage/.test(t)) return { type: "ira", label: /\bira\b/.test(t) ? "IRA" : "Retirement", debt: false };
  if (/\bcd\b|certificate/.test(t)) return { type: "cd", label: "CD", debt: false };
  if (/saving|money market|cash management|hsa/.test(t)) return { type: "savings", label: "Savings", debt: false };
  return { type: "checking", label: "Checking", debt: false };
}

/** Round to a friendly figure people would actually say out loud. */
const roundTo = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

/**
 * Smart defaults for the questions, from the accounts the family chose to import: a mortgage means they own their home
 * (value estimated at a typical 65% loan-to-value), an auto loan means a car worth a little more than what is owed.
 */
export function answerDefaults(selected: readonly { type: string; subtype: string; balance: number }[]): Pick<OnboardingAnswers, "own_home" | "home_value" | "vehicle_value"> & { homeEstimated: boolean; vehicleEstimated: boolean } {
  let mortgage = 0;
  let auto = 0;
  for (const o of selected) {
    const k = accountKind(o).type;
    if (k === "mortgage") mortgage += Math.abs(o.balance);
    if (k === "auto_loan") auto += Math.abs(o.balance);
  }
  return {
    own_home: mortgage > 0,
    home_value: mortgage > 0 ? roundTo(mortgage / 0.65, 5000) : 0,
    vehicle_value: auto > 0 ? roundTo(auto * 1.2, 500) : 0,
    homeEstimated: mortgage > 0,
    vehicleEstimated: auto > 0,
  };
}

// ------------------------------------------------------------------------------------------------ sandbox profiles (7b)

/** `GET /plaid/sandbox_profiles` row (docs/contracts.md section 7b). */
export interface SandboxProfileAccount {
  name: string;
  type: string;
  subtype: string;
  mask: string;
  balance: number;
}
export interface SandboxProfile {
  profile_id: string;
  display_name: string;
  summary: string;
  accounts: SandboxProfileAccount[];
  txn_count: number;
}
export const DEFAULT_PROFILE_ID = "family_demo";

/**
 * Stand-ins shaped exactly like the worker's response, used when the worker (or its profiles route) is not reachable.
 * `family_demo` mirrors data/plaid/sandbox_user.json, which the worker connects by default.
 */
export const MOCK_PROFILES: SandboxProfile[] = [
  {
    profile_id: DEFAULT_PROFILE_ID,
    display_name: "Ana and Luis, two incomes, a home and a car",
    summary: "A family with a mortgage, an auto loan, a rewards card and steady savings.",
    accounts: [
      { name: "Everyday Checking", type: "depository", subtype: "checking", mask: "0001", balance: 6200 },
      { name: "High-Yield Savings", type: "depository", subtype: "savings", mask: "0002", balance: 18500 },
      { name: "24-Month CD", type: "depository", subtype: "cd", mask: "0007", balance: 30000 },
      { name: "Traditional IRA", type: "investment", subtype: "ira", mask: "0006", balance: 88000 },
      { name: "Rewards Visa", type: "credit", subtype: "credit card", mask: "0003", balance: 1850 },
      { name: "Home Mortgage", type: "loan", subtype: "mortgage", mask: "0004", balance: 212000 },
      { name: "Auto Loan", type: "loan", subtype: "auto", mask: "0005", balance: 14300 },
    ],
    txn_count: 226,
  },
  {
    profile_id: "pnc_maya",
    display_name: "Maya, early-career nurse, saving for a first home",
    summary: "Steady paychecks, a student loan and a card she pays off most months.",
    accounts: [
      { name: "Checking", type: "depository", subtype: "checking", mask: "4410", balance: 3240 },
      { name: "Savings", type: "depository", subtype: "savings", mask: "4411", balance: 9800 },
      { name: "Cash Rewards Card", type: "credit", subtype: "credit card", mask: "4412", balance: 1420 },
      { name: "Student Loan", type: "loan", subtype: "student", mask: "4413", balance: 28600 },
    ],
    txn_count: 184,
  },
  {
    profile_id: "pnc_darnell",
    display_name: "Darnell, food-truck owner with uneven income",
    summary: "Business and personal money in one place, a small loan and a busy card.",
    accounts: [
      { name: "Business Checking", type: "depository", subtype: "checking", mask: "7720", balance: 7900 },
      { name: "Personal Checking", type: "depository", subtype: "checking", mask: "7721", balance: 1150 },
      { name: "Savings", type: "depository", subtype: "savings", mask: "7722", balance: 2300 },
      { name: "Business Card", type: "credit", subtype: "credit card", mask: "7723", balance: 4850 },
      { name: "Equipment Loan", type: "loan", subtype: "loan", mask: "7724", balance: 12000 },
    ],
    txn_count: 262,
  },
  {
    profile_id: "pnc_ruth",
    display_name: "Ruth and Harold, retired, drawing on an IRA",
    summary: "Social Security, a CD ladder and a large IRA. No debt.",
    accounts: [
      { name: "Checking", type: "depository", subtype: "checking", mask: "3301", balance: 5600 },
      { name: "Savings", type: "depository", subtype: "savings", mask: "3302", balance: 41000 },
      { name: "12-Month CD", type: "depository", subtype: "cd", mask: "3303", balance: 25000 },
      { name: "Rollover IRA", type: "investment", subtype: "ira", mask: "3304", balance: 182000 },
    ],
    txn_count: 121,
  },
];

const PROFILE_KINDS: { one: string; many: string; types: AccountType[] }[] = [
  { one: "checking", many: "checking", types: ["checking"] },
  { one: "savings", many: "savings", types: ["savings"] },
  { one: "CD", many: "CDs", types: ["cd"] },
  { one: "IRA", many: "retirement", types: ["ira"] },
  { one: "card", many: "cards", types: ["credit_card"] },
  { one: "mortgage", many: "mortgages", types: ["mortgage"] },
  { one: "loan", many: "loans", types: ["auto_loan", "personal_loan"] },
];
/** "7 accounts: 2 checking, savings, card, loan" (a count only where there are several of a kind). */
export function accountMix(accounts: readonly { type: string; subtype: string }[]): string {
  const parts = PROFILE_KINDS.map((k) => ({ k, n: accounts.filter((a) => k.types.includes(accountKind(a).type)).length }))
    .filter((x) => x.n > 0)
    .map(({ k, n }) => (n > 1 ? `${n} ${k.many}` : k.one));
  return `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}: ${parts.join(", ")}`;
}

function asProfiles(v: unknown): SandboxProfile[] {
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { profiles?: unknown }).profiles) ? (v as { profiles: unknown[] }).profiles : [];
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as Rec).profile_id === "string")
    .map((p) => ({
      profile_id: str(p.profile_id),
      display_name: str(p.display_name, str(p.profile_id)),
      summary: str(p.summary),
      accounts: (Array.isArray(p.accounts) ? p.accounts : []).map((a: Rec) => ({ name: str(a.name), type: str(a.type), subtype: str(a.subtype), mask: str(a.mask), balance: num(a.balance) })),
      txn_count: num(p.txn_count),
    }));
}

/** live: the worker's list. default: a worker without the profiles route (it only knows its default customer). */
export type ProfilesSource = "loading" | "live" | "default" | "mock";
interface ProfilesState {
  source: ProfilesSource;
  profiles: SandboxProfile[];
}
let profilesNow: ProfilesState = { source: "loading", profiles: [] };
const profileListeners = new Set<() => void>();
let profilesInflight: Promise<void> | null = null;
function setProfiles(p: ProfilesState): void {
  profilesNow = p;
  for (const l of profileListeners) l();
}

/**
 * Loads the sandbox customers once (and again on later calls until the live list has arrived, so a worker that comes
 * up mid-demo is picked up). Mock mode, or a worker that does not answer, uses MOCK_PROFILES. A live worker without
 * the profiles route only knows its default customer, so then only that one is offered.
 */
export function loadSandboxProfiles(mode: OnboardingMode): Promise<void> {
  if (profilesNow.source === "live" || mode === "detecting") return Promise.resolve();
  if (mode === "mock") {
    if (profilesNow.source !== "mock") setProfiles({ source: "mock", profiles: MOCK_PROFILES });
    return Promise.resolve();
  }
  if (profilesInflight) return profilesInflight;
  profilesInflight = (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    try {
      const res = await fetch(`${WORKER_URL}/plaid/sandbox_profiles`, { signal: ctl.signal });
      const list = res.ok ? asProfiles(await res.json()) : [];
      if (list.length) setProfiles({ source: "live", profiles: list });
      else if (res.status === 404) setProfiles({ source: "default", profiles: MOCK_PROFILES.slice(0, 1) });
      else setProfiles({ source: "mock", profiles: MOCK_PROFILES });
    } catch {
      setProfiles({ source: "mock", profiles: MOCK_PROFILES });
    } finally {
      clearTimeout(t);
      profilesInflight = null;
    }
  })();
  return profilesInflight;
}

export function useSandboxProfiles(mode: OnboardingMode): ProfilesState {
  useEffect(() => {
    void loadSandboxProfiles(mode);
  }, [mode]);
  return useSyncExternalStore(
    (cb) => {
      profileListeners.add(cb);
      return () => {
        profileListeners.delete(cb);
      };
    },
    () => profilesNow,
    () => profilesNow,
  );
}
export const findProfile = (id: string | undefined): SandboxProfile | undefined =>
  id ? (profilesNow.profiles.find((p) => p.profile_id === id) ?? MOCK_PROFILES.find((p) => p.profile_id === id)) : undefined;

// ------------------------------------------------------------------------------------------------ tiny tables

class Table<T> {
  private m = new Map<string, T>();
  private snap: readonly T[] | null = null;
  private ls = new Set<() => void>();
  constructor(private key: (r: T) => string) {}
  rows(): readonly T[] {
    if (!this.snap) this.snap = Array.from(this.m.values());
    return this.snap;
  }
  upsert(r: T): void {
    this.m.set(this.key(r), r);
    this.touch();
  }
  upsertMany(rs: readonly T[]): void {
    for (const r of rs) this.m.set(this.key(r), r);
    this.touch();
  }
  remove(r: T): void {
    if (this.m.delete(this.key(r))) this.touch();
  }
  removeWhere(pred: (r: T) => boolean): void {
    let changed = false;
    for (const [k, v] of this.m) {
      if (pred(v)) {
        this.m.delete(k);
        changed = true;
      }
    }
    if (changed) this.touch();
  }
  subscribe = (cb: () => void): (() => void) => {
    this.ls.add(cb);
    return () => {
      this.ls.delete(cb);
    };
  };
  private touch(): void {
    this.snap = null;
    queueMicrotask(() => {
      for (const cb of this.ls) cb();
    });
  }
}

const profiles = new Table<HouseholdProfile>((p) => p.household_id);
const options = new Table<AccountOption>((o) => o.id);

function useTable<T>(t: Table<T>): readonly T[] {
  return useSyncExternalStore(
    t.subscribe,
    () => t.rows(),
    () => emptyRows<T>(),
  );
}

// ------------------------------------------------------------------------------------------------ live wiring

type Rec = Record<string, unknown>;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : d);
const flag = (v: unknown): boolean => v === true;
function parse<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
const stamp = (v: unknown): string => (v && typeof v === "object" && "toDate" in v ? (v as { toDate(): Date }).toDate().toISOString() : new Date().toISOString());

const STATUSES: OnboardingStatus[] = ["welcome", "connect", "selecting", "questions", "done"];
function mapProfile(r: Rec): HouseholdProfile {
  const status = str(r.onboardingStatus) as OnboardingStatus;
  return {
    household_id: str(r.householdId),
    status: STATUSES.includes(status) ? status : "connect",
    answers: parse<Partial<OnboardingAnswers> | null>(r.answersJson, null),
    risk_comfort: num(r.riskComfort, 3),
    priorities: parse<string[]>(r.prioritiesJson, []),
    voting_enabled: flag(r.votingEnabled),
    voice_consent: flag(r.voiceConsent),
    created_at: stamp(r.createdAt),
    updated_at: stamp(r.updatedAt),
  };
}
function mapOption(r: Rec): AccountOption {
  return {
    id: str(r.id), household_id: str(r.householdId), item_id: str(r.itemId), account_id: str(r.accountId), name: str(r.name),
    official_name: str(r.officialName), mask: str(r.mask), type: str(r.type), subtype: str(r.subtype), balance: num(r.balance), selected: flag(r.selected),
  };
}

interface Tbl {
  onInsert(cb: (ctx: unknown, row: Rec) => void): void;
  onUpdate(cb: (ctx: unknown, oldRow: Rec, newRow: Rec) => void): void;
  onDelete(cb: (ctx: unknown, row: Rec) => void): void;
}
type Conn = NonNullable<ReturnType<typeof liveConnection>>;
type ReducerFn = (args: Rec) => Promise<unknown>;

const REQUIRED_REDUCERS = ["startOnboarding", "saveOnboardingAnswers", "selectBankAccounts", "finishOnboarding"];
function supportsOnboarding(conn: Conn): boolean {
  const reducers = conn.reducers as unknown as Rec;
  const db = conn.db as unknown as Rec;
  return REQUIRED_REDUCERS.every((n) => typeof reducers[n] === "function") && !!db.householdProfile && !!db.bankAccountOption;
}

const wired = new WeakSet<object>();
function wireLive(conn: Conn): void {
  if (wired.has(conn)) return;
  wired.add(conn);
  const db = conn.db as unknown as Record<string, Tbl>;
  db.householdProfile.onInsert((_c, r) => profiles.upsert(mapProfile(r)));
  db.householdProfile.onUpdate((_c, _o, r) => profiles.upsert(mapProfile(r)));
  db.householdProfile.onDelete((_c, r) => profiles.remove(mapProfile(r)));
  db.bankAccountOption.onInsert((_c, r) => options.upsert(mapOption(r)));
  db.bankAccountOption.onUpdate((_c, _o, r) => options.upsert(mapOption(r)));
  db.bankAccountOption.onDelete((_c, r) => options.remove(mapOption(r)));
}

async function callReducer(name: string, args: Rec): Promise<void> {
  const conn = liveConnection();
  const fn = (conn?.reducers as unknown as Record<string, ReducerFn | undefined> | undefined)?.[name];
  if (!conn || !fn) throw new Error("The database isn't ready for setup yet. Please try again in a moment.");
  await fn.call(conn.reducers, args);
}

// ------------------------------------------------------------------------------------------------ mode

export type OnboardingMode = "detecting" | "live" | "mock";
let modeNow: OnboardingMode = "detecting";
const modeListeners = new Set<() => void>();
let probe: Promise<OnboardingMode> | null = null;

function setMode(m: OnboardingMode): void {
  modeNow = m;
  for (const l of modeListeners) l();
}

/** Decide once per page load: live if the connected module has the onboarding reducers and tables, otherwise mock. */
export function ensureOnboardingMode(): Promise<OnboardingMode> {
  if (!probe) {
    probe = (async () => {
      const backend = await ensureBackend();
      const conn = backend.kind === "spacetime" ? liveConnection() : null;
      if (conn && supportsOnboarding(conn)) {
        wireLive(conn);
        setMode("live");
      } else {
        setMode("mock");
      }
      return modeNow;
    })();
  }
  return probe;
}

export function useOnboardingMode(): OnboardingMode {
  useEffect(() => {
    void ensureOnboardingMode();
  }, []);
  return useSyncExternalStore(
    (cb) => {
      modeListeners.add(cb);
      return () => {
        modeListeners.delete(cb);
      };
    },
    () => modeNow,
    () => "detecting" as const,
  );
}

const safeId = (s: string) => s.replace(/[^\w:.-]/g, "");

/** Live mode: subscribe to this household's profile and account options for as long as the page is open. */
export function useOnboardingSubscription(householdId: string | undefined, mode: OnboardingMode): void {
  useEffect(() => {
    if (mode !== "live" || !householdId) return;
    const conn = liveConnection();
    if (!conn) return;
    const id = safeId(householdId);
    let handle: { unsubscribe(): void } | undefined;
    try {
      handle = conn
        .subscriptionBuilder()
        .onError(() => undefined)
        .subscribe([`SELECT * FROM household_profile WHERE household_id = '${id}'`, `SELECT * FROM bank_account_option WHERE household_id = '${id}'`]);
    } catch {
      /* the room scope still gives us the rest */
    }
    return () => {
      try {
        handle?.unsubscribe();
      } catch {
        /* already ended */
      }
    };
  }, [mode, householdId]);
}

// ------------------------------------------------------------------------------------------------ hooks

export function useProfile(householdId: string | undefined): HouseholdProfile | undefined {
  const rows = useTable(profiles);
  return useMemo(() => (householdId ? rows.find((p) => p.household_id === householdId) : undefined), [rows, householdId]);
}

export function useAccountOptions(householdId: string | undefined): AccountOption[] {
  const rows = useTable(options);
  return useMemo(
    () => (householdId ? rows.filter((o) => o.household_id === householdId).sort((a, b) => accountOrder(a) - accountOrder(b) || a.name.localeCompare(b.name)) : []),
    [rows, householdId],
  );
}
const ORDER: AccountType[] = ["checking", "savings", "cd", "ira", "credit_card", "auto_loan", "personal_loan", "mortgage"];
const accountOrder = (o: AccountOption) => ORDER.indexOf(accountKind(o).type);

/** The household's bank connection (the one the account options belong to when there are several). */
export function useOnboardingBank(householdId: string | undefined): OnboardingBank | undefined {
  const conns = useBankConnections(householdId ?? "");
  const opts = useAccountOptions(householdId);
  return useMemo(() => {
    if (!householdId || !conns.length) return undefined;
    const pick = conns.find((c) => opts.some((o) => o.item_id === c.item_id)) ?? conns[conns.length - 1];
    return pick as unknown as OnboardingBank;
  }, [conns, opts, householdId]);
}

/** Alerts of kind `insight` (written by the onboarding_insights agent), oldest first so they read like a conversation. */
export function useInsights(householdId: string | undefined): Alert[] {
  const rows = useRows("alert");
  return useMemo(
    () => (householdId ? rows.filter((a) => a.household_id === householdId && (a.kind as string) === "insight").sort((a, b) => a.created_at.localeCompare(b.created_at)) : []),
    [rows, householdId],
  );
}

/** Goals written from the answers (source "onboarding"), in the order the family ranked them, the free-text one last. */
export function useOnboardingGoals(householdId: string | undefined): Goal[] {
  const rows = useRows("goal");
  const order = useProfile(householdId)?.priorities;
  return useMemo(() => {
    if (!householdId) return [];
    const prefix = `goal_${householdId}_`;
    const rank = (g: Goal) => {
      const i = order ? order.indexOf(g.id.slice(prefix.length)) : -1;
      return i >= 0 ? i : 99;
    };
    return rows
      .filter((g) => g.household_id === householdId && (g.source as string) === "onboarding")
      .sort((a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at) || a.title.localeCompare(b.title));
  }, [rows, householdId, order]);
}

/** The latest `onboarding_insights` run for this household and its trace events, in order. */
export function useInsightsRun(householdId: string | undefined): { run: AgentRun | undefined; events: TraceEvent[] } {
  const runs = useRows("agent_run");
  const run = useMemo(
    () =>
      householdId
        ? runs.filter((r) => r.household_id === householdId && (r.workflow as string) === INSIGHTS_WORKFLOW).sort((a, b) => b.started_at.localeCompare(a.started_at))[0]
        : undefined,
    [runs, householdId],
  );
  const events = useTraceEvents(run?.run_id);
  return { run, events };
}

/** Live mode: every household_profile row, while the page is open (the login page lists this browser's setups). */
export function useAllProfilesSubscription(mode: OnboardingMode): void {
  useEffect(() => {
    if (mode !== "live") return;
    const conn = liveConnection();
    if (!conn) return;
    let handle: { unsubscribe(): void } | undefined;
    try {
      handle = conn.subscriptionBuilder().onError(() => undefined).subscribe(["SELECT * FROM household_profile"]);
    } catch {
      /* the list still shows households, just without their setup status */
    }
    return () => {
      try {
        handle?.unsubscribe();
      } catch {
        /* already ended */
      }
    };
  }, [mode]);
}

export interface OwnedHousehold {
  household: Household;
  /** Private copies of a seed household have no profile and count as finished. */
  finished: boolean;
  status: OnboardingStatus | "copy";
}

/** Households this browser's identity created (onboardings and private copies), newest first. */
export function useOwnedHouseholds(): OwnedHousehold[] {
  const households = useRows("household");
  const profileRows = useTable(profiles);
  const me = useConnection().identity;
  return useMemo(() => {
    if (!me) return [];
    return households
      .filter((h) => h.owner === me && (h.id.startsWith("hh_onb_") || h.id.startsWith("hh_sbx_")))
      .map((h) => {
        const p = profileRows.find((x) => x.household_id === h.id);
        const status: OwnedHousehold["status"] = h.id.startsWith("hh_sbx_") ? "copy" : (p?.status ?? "connect");
        return { household: h, status, finished: status === "copy" || status === "done" };
      })
      .sort((a, b) => b.household.created_at.localeCompare(a.household.created_at));
  }, [households, profileRows, me]);
}

/** Which step a household is on, from its stored state (used to resume after a refresh and to follow along live). */
export function deriveStep(p: { status?: OnboardingStatus; bank?: OnboardingBank; hasRun: boolean }): number {
  if (p.status === "done" || p.hasRun) return 5;
  const b = p.bank?.status;
  if (b === "syncing" || b === "ok") return 4;
  if (b === "selecting") return 3;
  if (b === "error") return 2;
  if (p.status === "questions") return 4;
  if (p.status === "selecting") return 3;
  return 2;
}

// ------------------------------------------------------------------------------------------------ errors

export function friendlyError(e: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const m = raw.toLowerCase();
  if (!raw) return fallback;
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed") || m.includes("aborted")) {
    return "We couldn't reach the bank connector. It may be offline or waking up. Try again in a moment, or skip this step and add accounts later.";
  }
  if (m.includes("plaid_unconfigured")) return "The bank connector isn't set up on this server yet. You can skip this step and add accounts later.";
  if (m.includes("unknown_household") || m.includes("no household")) return "We're still setting up your household. Give it a few seconds and try again.";
  if (m.includes("sandbox_only")) return "The demo bank only works in the Plaid sandbox.";
  if (m.includes("plaid_error")) return "Plaid couldn't complete that. Please try again.";
  if (/^\d{3}$/.test(raw)) return `The bank connector answered with an error (${raw}). Please try again.`;
  return raw.length > 160 ? fallback : raw;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function poll<T>(fn: () => T | undefined, ms = 6000): Promise<T | undefined> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined || Date.now() - t0 > ms) return v;
    await sleep(60);
  }
}

/** POST to the worker; a fresh household can take a moment to reach the worker, so retry "unknown household". */
async function worker<T>(path: string, body: Rec): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await workerPost<T>(path, body);
    } catch (e) {
      last = e;
      if (!/unknown_household|no household/i.test(e instanceof Error ? e.message : "")) throw e;
      await sleep(900);
    }
  }
  throw last;
}

// ------------------------------------------------------------------------------------------------ actions

export const onboarding = {
  /** `start_onboarding` -> the new household id. */
  async start(householdName: string, displayName: string): Promise<string> {
    const mode = await ensureOnboardingMode();
    if (mode === "mock") return mock.start(householdName, displayName);
    const me = getConnection().identity;
    const before = new Set(store.rows("household").filter((h) => h.owner === me).map((h) => h.id));
    await callReducer("startOnboarding", { householdName, displayName });
    const made = await poll(() =>
      store.rows("household").filter((h) => h.owner === me && h.id.startsWith("hh_onb_") && !before.has(h.id)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0],
    );
    if (!made) throw new Error("Your household was created but hasn't appeared yet. Please try again.");
    return made.id;
  },

  /** Step 3, primary path: a Plaid Link token. */
  async linkToken(householdId: string): Promise<string> {
    const r = await worker<{ link_token: string }>("/plaid/link_token", { household_id: householdId });
    if (!r.link_token) throw new Error("plaid_error");
    return r.link_token;
  },

  /** Step 3: Plaid Link finished with a public token. */
  async exchange(householdId: string, publicToken: string): Promise<void> {
    if ((await ensureOnboardingMode()) === "mock") return mock.connect(householdId, DEFAULT_PROFILE_ID);
    await worker("/plaid/exchange", { household_id: householdId, public_token: publicToken, select: true });
  },

  /** Step 3, main path: connect one of the sandbox customers (section 7b). */
  async connectDemo(householdId: string, profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
    if ((await ensureOnboardingMode()) === "mock") return mock.connect(householdId, profileId);
    await worker("/plaid/sandbox_connect", { household_id: householdId, profile_id: profileId, select: true });
  },

  /** `select_bank_accounts` */
  async select(householdId: string, itemId: string, accountIds: string[]): Promise<void> {
    if ((await ensureOnboardingMode()) === "mock") return mock.select(householdId, itemId, accountIds);
    await callReducer("selectBankAccounts", { householdId, itemId, accountIdsJson: JSON.stringify(accountIds) });
  },

  /** `save_onboarding_answers` */
  async save(householdId: string, answers: OnboardingAnswers): Promise<void> {
    if ((await ensureOnboardingMode()) === "mock") return mock.save(householdId, answers);
    await callReducer("saveOnboardingAnswers", { householdId, answersJson: JSON.stringify(answers) });
  },

  /** `finish_onboarding` */
  async finish(householdId: string): Promise<void> {
    if ((await ensureOnboardingMode()) === "mock") return mock.finish(householdId);
    await callReducer("finishOnboarding", { householdId });
  },
};

// ================================================================================================ mock

const rid = (n = 6) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, "0");
const iso = () => new Date().toISOString();
const wf = (s: string) => s as Workflow;

const MOCK_BANK = "First Platypus Bank";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: string): () => number {
  let a = hash(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const timers: ReturnType<typeof setTimeout>[] = [];
const later = (ms: number, fn: () => void) => {
  timers.push(setTimeout(fn, ms));
};

let evSeq = 0;
function emit(hid: string, runId: string, seq: number, type: TraceType, agent: string, title: string, data?: unknown): void {
  const ev: TraceEvent = {
    id: 1_000_000_000 + ++evSeq, run_id: runId, household_id: hid, seq, ts: iso(), workflow: wf(INSIGHTS_WORKFLOW), agent, type, title, data,
    model: "mock", provider: "local",
  };
  store.upsert("trace_event", ev);
}

/** Realistic-looking six months of activity for the imported accounts (deterministic per household). */
function makeTxns(hid: string, accounts: Account[], now: Date): Transaction[] {
  const rand = rng(hid);
  const out: Transaction[] = [];
  const checking = accounts.find((a) => a.type === "checking");
  const card = accounts.find((a) => a.type === "credit_card");
  const spend = checking ?? card;
  let n = 0;
  const add = (acct: Account | undefined, date: Date, amount: number, merchant: string, category: string, recurring: boolean) => {
    if (!acct) return;
    out.push({
      id: `txn_plaid_${hid}_${++n}`, household_id: hid, account_id: acct.id, date: isoDate(date), amount: Math.round(amount * 100) / 100, merchant,
      category, description: merchant, is_recurring: recurring, source: "plaid",
    });
  };
  const groceries = ["H-E-B", "Tom Thumb", "Trader Joe's", "Whole Foods"];
  const dining = ["Torchy's Tacos", "Chipotle", "Starbucks", "Pizza Hut", "Whataburger"];
  for (let m = 5; m >= 0; m--) {
    const day = (d: number) => new Date(now.getFullYear(), now.getMonth() - m, d, 12);
    const past = (d: Date) => d <= now;
    for (const d of [1, 15]) if (past(day(d))) add(checking, day(d), 2650 + Math.round(rand() * 40), "Direct deposit, payroll", "income", true);
    if (past(day(1))) add(checking, day(1), accounts.some((a) => a.type === "mortgage") ? -1640 : -1450, accounts.some((a) => a.type === "mortgage") ? "Mortgage payment" : "Rent", "housing", true);
    if (past(day(5)) && accounts.some((a) => a.type === "auto_loan")) add(checking, day(5), -412, "Auto loan payment", "transport", true);
    if (past(day(12))) add(checking, day(12), -Math.round(40 + rand() * 90), "Oncor electric", "utilities", true);
    if (past(day(18))) add(checking, day(18), -64.99, "Spectrum internet", "utilities", true);
    if (past(day(8))) add(card ?? spend, day(8), -15.49, "Netflix", "subscriptions", true);
    if (past(day(9))) add(card ?? spend, day(9), -10.99, "Spotify", "subscriptions", true);
    if (past(day(20))) add(checking, day(20), -Math.min(card?.balance ?? 0, 300), "Credit card payment", "debt", true);
    for (let i = 0; i < 9; i++) if (past(day(2 + i * 3))) add(card ?? spend, day(2 + i * 3), -(38 + rand() * 90), groceries[Math.floor(rand() * groceries.length)], "groceries", false);
    for (let i = 0; i < 7; i++) if (past(day(3 + i * 4))) add(card ?? spend, day(3 + i * 4), -(9 + rand() * 38), dining[Math.floor(rand() * dining.length)], "dining", false);
    for (let i = 0; i < 3; i++) if (past(day(6 + i * 9))) add(card ?? spend, day(6 + i * 9), -(32 + rand() * 24), "Shell", "transport", false);
    for (let i = 0; i < 2; i++) if (past(day(10 + i * 11))) add(card ?? spend, day(10 + i * 11), -(20 + rand() * 120), "Target", "shopping", false);
  }
  return out;
}

function mockRecompute(hid: string): void {
  const accounts = store.rows("account").filter((a) => a.household_id === hid);
  const members = store.rows("member").filter((m) => m.household_id === hid);
  const obligations = store.rows("obligation").filter((o) => o.household_id === hid);
  const spends = store.rows("txn").filter((t) => t.household_id === hid && t.amount < 0 && !t.is_recurring);
  const months = Math.max(1, new Set(spends.map((t) => t.date.slice(0, 7))).size);
  const varSpend = Math.max(800, Math.round(-spends.reduce((s, t) => s + t.amount, 0) / months));
  const now = new Date();
  store.upsertMany("health_indicator", computeHealth(hid, { accounts, members, obligations, varSpend, nwTrend: 2.1 }, now.toISOString()));
  store.removeWhere("forecast_point", (p) => p.household_id === hid);
  store.upsertMany("forecast_point", computeForecast(hid, { accounts, members, obligations, varSpend, nwTrend: 2.1 }, now));
}

function setBank(itemId: string, patch: Partial<OnboardingBank>): void {
  store.patch("bank_connection", itemId, patch as never);
}
function setProfile(hid: string, patch: Partial<HouseholdProfile>): void {
  const cur = profiles.rows().find((p) => p.household_id === hid);
  if (cur) profiles.upsert({ ...cur, ...patch, updated_at: iso() });
}

const mock = {
  async start(householdName: string, displayName: string): Promise<string> {
    await sleep(350);
    const id = `hh_onb_${rid()}`;
    const now = iso();
    store.upsert("household", { id, name: householdName, city: "", state: "", persona: "", template_id: "", owner: getConnection().identity, home_value: 0, vehicle_value: 0, created_at: now });
    store.upsert("member", { id: `mem_${id}_0`, household_id: id, name: displayName, age: 0, role: "parent", income_annual: 0 });
    profiles.upsert({ household_id: id, status: "connect", answers: null, risk_comfort: 3, priorities: [], voting_enabled: true, voice_consent: false, created_at: now, updated_at: now });
    return id;
  },

  async connect(hid: string, profileId: string): Promise<void> {
    if (store.rows("bank_connection").some((b) => b.household_id === hid && b.status !== "error")) return;
    const profile = findProfile(profileId) ?? MOCK_PROFILES[0];
    await sleep(450);
    const itemId = `item_mock_${rid()}`;
    store.upsert("bank_connection", { item_id: itemId, household_id: hid, institution_name: MOCK_BANK, status: "linking", accounts_count: 0, txns_count: 0 });
    later(1400, () => {
      options.upsertMany(
        profile.accounts.map((a, i) => {
          const account_id = `${profile.profile_id}_${i}`;
          return { ...a, account_id, official_name: a.name, id: `${itemId}:${account_id}`, household_id: hid, item_id: itemId, selected: true };
        }),
      );
      setBank(itemId, { status: "selecting", accounts_count: profile.accounts.length });
      setProfile(hid, { status: "selecting" });
    });
  },

  async select(hid: string, itemId: string, ids: string[]): Promise<void> {
    await sleep(250);
    const chosen = options.rows().filter((o) => o.item_id === itemId && ids.includes(o.account_id));
    if (!chosen.length) throw new Error("Pick at least one account to import.");
    for (const o of options.rows().filter((x) => x.item_id === itemId)) options.upsert({ ...o, selected: ids.includes(o.account_id) });
    setBank(itemId, { status: "syncing", accounts_count: 0, txns_count: 0 });
    setProfile(hid, { status: "questions" });

    const accounts: Account[] = chosen.map((o) => {
      const k = accountKind(o);
      const pay = k.type === "mortgage" ? 1640 : k.type === "auto_loan" ? 412 : k.type === "credit_card" ? Math.max(35, Math.round(o.balance * 0.025)) : undefined;
      return {
        id: `acct_plaid_${o.account_id}_${hid}`, household_id: hid, type: k.type, institution: MOCK_BANK, nickname: o.name, balance: o.balance,
        rate_pct: k.type === "mortgage" ? 6.4 : k.type === "auto_loan" ? 5.9 : k.type === "credit_card" ? 22.9 : k.type === "savings" ? 4.1 : undefined,
        credit_limit: k.type === "credit_card" ? Math.max(5000, Math.ceil((o.balance * 3) / 500) * 500) : undefined,
        monthly_payment: pay, opened_date: "2019-06-01", owner_member_ids: [], source: "plaid",
      };
    });
    accounts.forEach((a, i) => {
      later(500 + i * 450, () => {
        store.upsert("account", a);
        setBank(itemId, { accounts_count: i + 1 });
      });
    });
    const t0 = 500 + accounts.length * 450;
    const txns = makeTxns(hid, accounts, new Date());
    const obligations: Obligation[] = accounts
      .filter((a) => a.monthly_payment)
      .map((a, i) => ({ id: `obl_plaid_${hid}_${i}`, household_id: hid, name: `${a.nickname} payment`, amount: a.monthly_payment ?? 0, due_day: [1, 5, 20][i % 3], account_id: a.id, kind: "loan" as const }));
    obligations.push(
      { id: `obl_plaid_${hid}_elec`, household_id: hid, name: "Electric", amount: 85, due_day: 12, account_id: "", kind: "bill" },
      { id: `obl_plaid_${hid}_net`, household_id: hid, name: "Internet", amount: 65, due_day: 18, account_id: "", kind: "bill" },
    );
    [0.25, 0.5, 0.75].forEach((f, i) => later(t0 + 400 + i * 450, () => setBank(itemId, { txns_count: Math.round(txns.length * f) })));
    later(t0 + 1900, () => {
      store.upsertMany("txn", txns);
      store.upsertMany("obligation", obligations);
      setBank(itemId, { status: "ok", txns_count: txns.length, last_synced_at: iso() });
      mockRecompute(hid);
    });
  },

  async save(hid: string, a: OnboardingAnswers): Promise<void> {
    await sleep(300);
    const members = a.members.filter((m) => m.name.trim());
    const kept = new Set<string>();
    members.forEach((m, i) => {
      const prev = store.rows("member").find((x) => x.household_id === hid && (x.id === m.id || x.name.toLowerCase() === m.name.trim().toLowerCase()));
      const id = prev?.id ?? `mem_${hid}_${i + 1}`;
      kept.add(id);
      store.upsert("member", { id, household_id: hid, name: m.name.trim(), age: m.age, role: m.role, income_annual: m.income_annual });
    });
    const h = store.get("household", hid);
    if (h) store.upsert("household", { ...h, home_value: a.own_home ? a.home_value : 0, vehicle_value: a.vehicle_value });
    const now = iso();
    const goals: Goal[] = a.priorities
      .map((key, i) => ({ key, i, p: PRIORITIES.find((p) => p.key === key) }))
      .filter((x) => x.p)
      .map(({ key, i, p }) => ({ id: `goal_${hid}_${key}`, household_id: hid, title: p!.goal, priority: i === 0 ? "high" : "medium", feasibility: "", source: "onboarding" as Goal["source"], created_at: now, updated_at: now }));
    if (a.goal_text.trim()) goals.push({ id: `goal_${hid}_custom`, household_id: hid, title: a.goal_text.trim().slice(0, GOAL_TEXT_MAX), priority: "medium", feasibility: "", source: "onboarding" as Goal["source"], created_at: now, updated_at: now });
    store.removeWhere("goal", (g) => g.household_id === hid && (g.source as string) === "onboarding");
    store.upsertMany("goal", goals);
    setProfile(hid, { status: "questions", answers: a, risk_comfort: a.risk_comfort, priorities: a.priorities, voting_enabled: a.voting_enabled, voice_consent: a.voice_consent });
    mockRecompute(hid);
  },

  async finish(hid: string): Promise<void> {
    await sleep(300);
    const bank = store.rows("bank_connection").find((b) => b.household_id === hid);
    if ((bank?.status as string) === "selecting") throw new Error("Choose which accounts to import first.");
    if (bank?.status === "syncing" || bank?.status === "linking") throw new Error("The bank sync is still running, try again in a few seconds.");
    mockRecompute(hid);
    setProfile(hid, { status: "done" });
    runInsights(hid);
  },
};

const usdRound = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.round(n));

/** Plays an `onboarding_insights` run: trace events, then plain-English insights and goal checks, derived from the data. */
function runInsights(hid: string): void {
  const runId = `run_onb_${rid()}`;
  const txns = store.rows("txn").filter((t) => t.household_id === hid);
  const accounts = store.rows("account").filter((a) => a.household_id === hid);
  const members = store.rows("member").filter((m) => m.household_id === hid);
  const goals = store.rows("goal").filter((g) => g.household_id === hid && (g.source as string) === "onboarding");
  const liquid = accounts.filter((a) => a.type === "checking" || a.type === "savings").reduce((s, a) => s + a.balance, 0);
  const months = Math.max(1, new Set(txns.map((t) => t.date.slice(0, 7))).size);
  const monthlySpend = Math.max(1, -txns.filter((t) => t.amount < 0 && t.category !== "debt").reduce((s, t) => s + t.amount, 0) / months);
  const runway = liquid / monthlySpend;
  const card = accounts.find((a) => a.type === "credit_card");
  const monthlyDebt = accounts.reduce((s, a) => s + (a.monthly_payment ?? 0), 0);
  const income = members.reduce((s, m) => s + m.income_annual, 0) / 12;

  store.upsert("agent_run", { run_id: runId, job_id: 0, workflow: wf(INSIGHTS_WORKFLOW), household_id: hid, status: "running", started_at: iso(), providers: ["local"] });
  let seq = 0;
  let t = 0;
  const step = (ms: number, fn: () => void) => {
    t += ms;
    later(t, fn);
  };
  const insight = (severity: Alert["severity"], title: string, detail: string) => {
    const a: Alert = { id: `alert_onb_${rid()}`, household_id: hid, severity, kind: "insight" as AlertKind, title, detail, related_ids: [], created_at: iso(), acknowledged_by: "" };
    store.upsert("alert", a);
  };

  step(200, () => emit(hid, runId, ++seq, "run_started", "planner", "Getting to know your household"));
  step(900, () => emit(hid, runId, ++seq, "tool_call", "analyst", `Reading ${txns.length.toLocaleString("en-US")} transactions…`));
  step(1200, () => emit(hid, runId, ++seq, "tool_result", "analyst", `Spending is about ${usdRound(monthlySpend)} a month`));
  step(500, () => {
    emit(hid, runId, ++seq, "tool_call", "analyst", `Looking over ${accounts.length} accounts…`);
  });
  step(900, () =>
    insight(
      runway >= 4 ? "info" : "warn",
      `Your cash covers about ${runway.toFixed(1)} months of spending`,
      runway >= 4 ? "That is a comfortable cushion. Anything beyond six months could be working harder for you." : "A cushion of three to six months is the usual goal. Your checking and savings are a little below that today.",
    ),
  );
  if (card && card.balance > 0) {
    step(700, () => emit(hid, runId, ++seq, "thought", "analyst", "Checking interest costs…"));
    step(800, () => insight("warn", `Your credit card carries ${usdRound(card.balance)}`, `At around 23% interest that costs roughly ${usdRound(card.balance * 0.229)} a year. Paying it down first is the best guaranteed return you have.`));
  }
  step(700, () => emit(hid, runId, ++seq, "thought", "analyst", "Checking your goals…"));
  step(900, () => {
    goals.forEach((g) => {
      const key = g.id.slice(`goal_${hid}_`.length);
      const feas: Goal["feasibility"] =
        key === "emergency_fund" ? (runway >= 3 ? "on_track" : "stretch")
        : key === "debt_payoff" ? (card && card.balance > 3000 ? "stretch" : "on_track")
        : key === "retirement" || key === "travel" ? "on_track"
        : "stretch";
      store.patch("goal", g.id, { feasibility: feas, updated_at: iso() });
    });
    emit(hid, runId, ++seq, "tool_result", "goal_checker", goals.length ? `Checked ${goals.length} goal${goals.length === 1 ? "" : "s"} against your accounts` : "No goals yet. You can add some any time");
  });
  if (income > 0) {
    step(600, () => insight(monthlyDebt / income > 0.36 ? "warn" : "info", `Loan and card payments use about ${Math.round((monthlyDebt / income) * 100)}% of your income`, "Lenders like to see this under 36%. We will keep an eye on it as things change."));
  }
  step(700, () => emit(hid, runId, ++seq, "message", "planner", "Writing up what I found…"));
  step(800, () => {
    const count = store.rows("alert").filter((a) => a.household_id === hid && (a.kind as string) === "insight").length;
    emit(hid, runId, ++seq, "final", "planner", `Done. ${count} insight${count === 1 ? "" : "s"} ready`);
    store.patch("agent_run", runId, { status: "done", finished_at: iso() });
  });
}
