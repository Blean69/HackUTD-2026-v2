// Onboarding, connectors first (docs/contracts.md section 7): create a household, link a bank (worker), pick accounts, answer
// questions, finish. Every step is a SpacetimeDB row, so a second family member can join mid-flow.
//
//   start_onboarding      -> household hh_onb_<suffix> (owner = caller) + the caller as a member + household_profile (connect)
//   [worker] agent_set_account_options -> bank_account_option rows, profile "selecting", bank_connection "selecting"
//   select_bank_accounts  -> marks the chosen accounts, queues plaid_sync (imports only those), profile "questions"
//   save_onboarding_answers -> members, home/vehicle value, goals (source "onboarding"), profile
//   finish_onboarding     -> recompute_household + an `onboarding_insights` job (insight alerts, goal feasibility, a first proposal)
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { recomputeHousehold } from '../recompute';
import { backfillCreditHistory } from '../credit_store';
import { callerName, cleanText, enqueueJob, fail, markDirty, parseJsonArray, randomSuffix, requireHousehold, upsertPresence, type Ctx } from '../util';

/** Priority keys the questions offer (contracts.md section 7, step 5), most important first as the family orders them. */
const PRIORITIES: Record<string, string> = {
  emergency_fund: 'Build an emergency fund',
  home: 'Save for a home',
  college: 'Save for college',
  retirement: 'Boost retirement savings',
  debt_payoff: 'Pay off debt',
  travel: 'Save for travel',
  business: 'Start or grow a business',
  caring_for_parents: 'Support the care of parents',
};
const ROLES = ['parent', 'child', 'grandparent', 'other'];
const STATUS_ORDER = ['welcome', 'connect', 'selecting', 'questions', 'done'];
const MAX_ANSWERS = 8000;
const MAX_MEMBERS = 12;

type Row = Record<string, unknown>;

function requireWorker(ctx: Ctx): void {
  if (!ctx.db.worker.identity.find(ctx.sender)) fail('worker only');
}
function requireProfile(ctx: Ctx, household_id: string) {
  requireHousehold(ctx, household_id);
  const p = ctx.db.household_profile.household_id.find(household_id);
  if (!p) fail(`"${household_id}" is not an onboarding household`);
  return p;
}
/** Only ever move the status forward (a late "selecting" must not undo "questions"). */
function advance(ctx: Ctx, household_id: string, to: string): void {
  const p = ctx.db.household_profile.household_id.find(household_id);
  if (!p) return;
  if (STATUS_ORDER.indexOf(to) > STATUS_ORDER.indexOf(p.onboarding_status)) {
    ctx.db.household_profile.household_id.update({ ...p, onboarding_status: to, updated_at: ctx.timestamp });
  }
}
const goalId = (household_id: string, key: string): string => `goal_${household_id}_${key}`;

export const start_onboarding = spacetimedb.reducer(
  { household_name: t.string(), display_name: t.string() },
  (ctx, { household_name, display_name }) => {
    const hhName = cleanText(household_name, 'household_name', 60);
    const name = cleanText(display_name, 'display_name', 40);
    let suffix = randomSuffix(ctx, 6);
    for (let i = 0; i < 20 && ctx.db.household.id.find(`hh_onb_${suffix}`); i++) suffix = randomSuffix(ctx, 6);
    const hh = `hh_onb_${suffix}`;
    if (ctx.db.household.id.find(hh)) fail('could not allocate a household id, try again');
    ctx.db.household.insert({
      id: hh,
      name: hhName,
      city: '',
      state: '',
      persona: '',
      home_value: 0,
      vehicle_value: 0,
      template_id: '',
      owner: ctx.sender,
      created_at: ctx.timestamp,
    });
    ctx.db.member.insert({ id: `mem_onb_${suffix}_1`, household_id: hh, name, age: 0, role: 'parent', income_annual: 0 });
    ctx.db.household_profile.insert({
      household_id: hh,
      onboarding_status: 'connect',
      answers_json: '{}',
      risk_comfort: 3,
      priorities_json: '[]',
      voting_enabled: true,
      voice_consent: false,
      created_at: ctx.timestamp,
      updated_at: ctx.timestamp,
    });
    const prev = ctx.db.presence.identity.find(ctx.sender);
    upsertPresence(ctx, hh, name, prev && prev.role !== 'guest' ? prev.role : 'family');
  },
);

/**
 * Worker-only. Replace the account choices for one linked bank. Existing `selected` flags survive a refresh; new accounts
 * default to selected. rows_json: [{account_id, name, official_name?, mask?, type, subtype?, balance, selected?}].
 * Moves the profile (connect -> selecting) and the bank connection to "selecting".
 */
export const agent_set_account_options = spacetimedb.reducer(
  { household_id: t.string(), item_id: t.string(), rows_json: t.string() },
  (ctx, { household_id, item_id, rows_json }) => {
    requireWorker(ctx);
    requireHousehold(ctx, household_id);
    const item = cleanText(item_id, 'item_id', 200);
    const rows = parseJsonArray(rows_json, 'rows_json').map((r, i) => {
      if (typeof r !== 'object' || r === null || Array.isArray(r)) return fail(`rows_json[${i}] must be an object`);
      return r as Row;
    });
    const str = (r: Row, k: string, fallback = ''): string => (r[k] === undefined || r[k] === null ? fallback : String(r[k]));
    const keep = new Set<string>();
    for (const r of rows) {
      const account_id = cleanText(str(r, 'account_id'), 'account_id', 200);
      const id = `${item}:${account_id}`;
      keep.add(id);
      const bal = Number(r['balance']);
      const prev = ctx.db.bank_account_option.id.find(id);
      const row = {
        id,
        household_id,
        item_id: item,
        account_id,
        name: cleanText(str(r, 'name', account_id), 'name', 120),
        official_name: cleanText(str(r, 'official_name'), 'official_name', 160, true),
        mask: cleanText(str(r, 'mask'), 'mask', 12, true),
        type: cleanText(str(r, 'type', 'other'), 'type', 40),
        subtype: cleanText(str(r, 'subtype'), 'subtype', 60, true),
        balance: Number.isFinite(bal) ? bal : 0,
        selected: typeof r['selected'] === 'boolean' ? (r['selected'] as boolean) : (prev?.selected ?? true),
      };
      if (prev) ctx.db.bank_account_option.id.update(row);
      else ctx.db.bank_account_option.insert(row);
    }
    for (const o of [...ctx.db.bank_account_option.item_id.filter(item)]) {
      if (o.household_id === household_id && !keep.has(o.id)) ctx.db.bank_account_option.id.delete(o.id);
    }
    const conn = ctx.db.bank_connection.item_id.find(item);
    if (conn && conn.household_id === household_id) ctx.db.bank_connection.item_id.update({ ...conn, status: 'selecting', accounts_count: rows.length, error: '' });
    advance(ctx, household_id, 'selecting');
  },
);

/**
 * The family chose which of the offered accounts to import. `account_ids_json` is a JSON array of Plaid account ids from
 * `bank_account_option`. Queues `plaid_sync` (one waiting job is enough), which imports only the selected accounts, and moves the
 * profile on to the questions. Adding an account that was not selected before restarts the item's transaction cursor so its
 * history is pulled too.
 */
export const select_bank_accounts = spacetimedb.reducer(
  { household_id: t.string(), item_id: t.string(), account_ids_json: t.string() },
  (ctx, { household_id, item_id, account_ids_json }) => {
    requireHousehold(ctx, household_id);
    const options = [...ctx.db.bank_account_option.item_id.filter(item_id)].filter((o) => o.household_id === household_id);
    if (options.length === 0) fail(`no accounts were offered for bank item "${item_id}"`);
    const chosen = new Set<string>();
    for (const v of parseJsonArray(account_ids_json, 'account_ids_json')) {
      if (typeof v !== 'string') fail('account_ids_json must be an array of account id strings');
      if (!options.some((o) => o.account_id === v)) fail(`unknown account "${v}" for this bank`);
      chosen.add(v);
    }
    if (chosen.size === 0) fail('select at least one account to import');
    let added = false;
    for (const o of options) {
      const selected = chosen.has(o.account_id);
      if (selected && !o.selected) added = true;
      if (o.selected !== selected) ctx.db.bank_account_option.id.update({ ...o, selected });
    }
    const stored = ctx.db.plaid_item.item_id.find(item_id);
    if (added && stored && stored.household_id === household_id && stored.cursor !== '') ctx.db.plaid_item.item_id.update({ ...stored, cursor: '' });

    const conn = ctx.db.bank_connection.item_id.find(item_id);
    if (conn && conn.household_id === household_id) ctx.db.bank_connection.item_id.update({ ...conn, status: 'syncing', error: '' });
    advance(ctx, household_id, 'questions');
    for (const j of ctx.db.agent_job.household_id.filter(household_id)) {
      if (j.workflow === 'plaid_sync' && j.status === 'queued') return;
    }
    enqueueJob(ctx, 'plaid_sync', household_id, household_id, { household_id, requested_by: callerName(ctx), selected: chosen.size });
  },
);

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function asMoney(v: unknown, field: string, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e10) return fail(`${field} must be a non-negative number`);
  return n;
}

/**
 * Save the questionnaire. `answers_json` is an object with any of:
 *   members          [{id?, name, role parent|child|grandparent|other, age, income_annual}]  (matched by id, else name; added or updated)
 *   own_home         boolean       home_value  number (ignored, stored as 0, when own_home is false)
 *   vehicle_value    number
 *   priorities       ["emergency_fund","home","college","retirement","debt_payoff","travel","business","caring_for_parents"], most important first
 *   goal_text        free-text goal
 *   risk_comfort     1..5
 *   voting_enabled   boolean       voice_consent boolean (Table Mode)
 * Upserts members, `home_value` / `vehicle_value`, goals (source "onboarding", id `goal_<household>_<priority>`; a priority the
 * family dropped is removed again) and the profile. Calling again is safe.
 */
export const save_onboarding_answers = spacetimedb.reducer(
  { household_id: t.string(), answers_json: t.string() },
  (ctx, { household_id, answers_json }) => {
    const profile = requireProfile(ctx, household_id);
    const hh = requireHousehold(ctx, household_id);
    if ((answers_json ?? '').length > MAX_ANSWERS) fail(`answers_json is too long (max ${MAX_ANSWERS} characters)`);
    let a: Row;
    try {
      const v: unknown = JSON.parse(answers_json);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail('answers_json must be a JSON object');
      a = v as Row;
    } catch {
      return fail('answers_json must be a JSON object');
    }

    // members
    if (a['members'] !== undefined) {
      if (!Array.isArray(a['members'])) fail('members must be an array');
      const list = a['members'] as unknown[];
      if (list.length > MAX_MEMBERS) fail(`at most ${MAX_MEMBERS} members`);
      const existing = [...ctx.db.member.household_id.filter(household_id)];
      let nextN = existing.length + 1;
      list.forEach((raw, i) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`members[${i}] must be an object`);
        const m = raw as Row;
        const name = cleanText(String(m['name'] ?? ''), `members[${i}].name`, 60);
        const role = ROLES.includes(String(m['role'])) ? String(m['role']) : 'other';
        const age = Math.round(asMoney(m['age'], `members[${i}].age`, 0));
        if (age > 120) fail(`members[${i}].age must be 0 to 120`);
        const income_annual = asMoney(m['income_annual'], `members[${i}].income_annual`, 0);
        const byId = typeof m['id'] === 'string' ? existing.find((x) => x.id === m['id']) : undefined;
        const prev = byId ?? existing.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (prev) ctx.db.member.id.update({ ...prev, name, role, age, income_annual });
        else {
          let id = `mem_${household_id.slice(3)}_${nextN++}`;
          while (ctx.db.member.id.find(id)) id = `mem_${household_id.slice(3)}_${nextN++}`;
          const row = { id, household_id, name, age, role, income_annual };
          ctx.db.member.insert(row);
          existing.push(row);
        }
      });
    }

    // housing and vehicles
    const own = asBool(a['own_home'], hh.home_value > 0);
    const homeValue = own ? asMoney(a['home_value'], 'home_value', hh.home_value) : 0;
    const vehicleValue = asMoney(a['vehicle_value'], 'vehicle_value', hh.vehicle_value);
    if (a['own_home'] !== undefined || a['home_value'] !== undefined || a['vehicle_value'] !== undefined) {
      ctx.db.household.id.update({ ...hh, home_value: homeValue, vehicle_value: vehicleValue });
    }

    // priorities -> goals
    let priorities: string[] = JSON.parse(profile.priorities_json) as string[];
    if (a['priorities'] !== undefined) {
      if (!Array.isArray(a['priorities'])) fail('priorities must be an array');
      priorities = [];
      for (const raw of a['priorities'] as unknown[]) {
        const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (!(key in PRIORITIES)) fail(`unknown priority "${String(raw)}" (use ${Object.keys(PRIORITIES).join(', ')})`);
        if (!priorities.includes(key)) priorities.push(key);
      }
    }
    const goalText = a['goal_text'] === undefined ? undefined : cleanText(String(a['goal_text'] ?? ''), 'goal_text', 140, true);
    if (a['priorities'] !== undefined || goalText !== undefined) {
      const wanted = new Map<string, { title: string; priority: number }>();
      priorities.forEach((k, i) => wanted.set(k, { title: PRIORITIES[k]!, priority: i + 1 }));
      const customText = goalText ?? (ctx.db.goal.id.find(goalId(household_id, 'custom'))?.title ?? '');
      if (customText) wanted.set('custom', { title: customText, priority: priorities.length + 1 });
      const prefix = `goal_${household_id}_`;
      for (const g of [...ctx.db.goal.household_id.filter(household_id)]) {
        if (g.id.startsWith(prefix) && g.source === 'onboarding' && !wanted.has(g.id.slice(prefix.length))) ctx.db.goal.id.delete(g.id);
      }
      for (const [key, w] of wanted) {
        const id = goalId(household_id, key);
        const prev = ctx.db.goal.id.find(id);
        if (prev) ctx.db.goal.id.update({ ...prev, title: w.title, priority: w.priority, updated_at: ctx.timestamp });
        else {
          ctx.db.goal.insert({ id, household_id, title: w.title, target_amount: 0, target_date: '', priority: w.priority, feasibility: '', evidence_quote: '', source: 'onboarding', created_at: ctx.timestamp, updated_at: ctx.timestamp });
        }
      }
    }

    // profile
    let risk = profile.risk_comfort;
    if (a['risk_comfort'] !== undefined) {
      risk = Math.round(Number(a['risk_comfort']));
      if (!Number.isFinite(risk) || risk < 1 || risk > 5) fail('risk_comfort must be 1 to 5');
    }
    const status = profile.onboarding_status === 'done' ? 'done' : STATUS_ORDER.indexOf(profile.onboarding_status) < STATUS_ORDER.indexOf('questions') ? 'questions' : profile.onboarding_status;
    ctx.db.household_profile.household_id.update({
      ...profile,
      onboarding_status: status,
      answers_json: answers_json,
      risk_comfort: risk,
      priorities_json: JSON.stringify(priorities),
      voting_enabled: asBool(a['voting_enabled'], profile.voting_enabled),
      voice_consent: asBool(a['voice_consent'], profile.voice_consent),
      updated_at: ctx.timestamp,
    });
    markDirty(ctx, household_id);
  },
);

/**
 * Finish onboarding: refresh the health math now and queue the `onboarding_insights` job (Nemotron writes 3 to 5 insight alerts,
 * checks each goal's feasibility and suggests a first proposal). Refused while a bank is mid-sync or waiting for its account
 * selection, so the insights see the imported data. Calling it again after it finished does nothing.
 */
export const finish_onboarding = spacetimedb.reducer({ household_id: t.string() }, (ctx, { household_id }) => {
  const profile = requireProfile(ctx, household_id);
  if (profile.onboarding_status === 'done') return;
  for (const c of ctx.db.bank_connection.household_id.filter(household_id)) {
    if (c.status === 'selecting') fail('choose which accounts to import first');
    if (c.status === 'linking' || c.status === 'syncing') fail('the bank sync is still running, try again in a few seconds');
  }
  recomputeHousehold(ctx, household_id);
  try {
    backfillCreditHistory(ctx, household_id); // ~6 monthly credit-score points from the imported transactions
  } catch (e) {
    console.error(`finish_onboarding: credit history for ${household_id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.db.household_profile.household_id.update({ ...profile, onboarding_status: 'done', updated_at: ctx.timestamp });
  let answers: unknown = {};
  try {
    answers = JSON.parse(profile.answers_json);
  } catch {
    answers = {};
  }
  enqueueJob(ctx, 'onboarding_insights', household_id, household_id, {
    household_id,
    answers,
    priorities: JSON.parse(profile.priorities_json) as string[],
    risk_comfort: profile.risk_comfort,
    voting_enabled: profile.voting_enabled,
    voice_consent: profile.voice_consent,
    finished_by: callerName(ctx),
  });
});
