// proposal_check: the affordability check behind Family voting (docs/contracts.md section 6).
//
// `create_proposal` (and `seed_proposals`) queue a `what_if` job whose subject is the proposal id and whose input carries
// the proposal ({proposal_id, title, amount, details, created_by}). The what_if workflow hands those jobs to this module:
//
//   plan -> proposal -> scenario (deterministic map of title/amount/details) -> simulate_scenario -> get_forecast
//        -> [scam_guard: detect_scam_signals, only when the title/details talk about moving money to family or gift cards]
//        -> plain-language narrative (Nemotron) -> agent_update_proposal {verdict, analysis_json}
//
// verdict is fine | tight | risky (simulator verdict comfortable | tight | shortfall); a medium/high scam risk always makes
// it `risky`, leads the summary with a scam warning, and raises a scam alert. analysis_json has the ScenarioResult shape
// (summary, metrics, series, low_point, suggestion, ...) plus `proposal` and, when checked, `scam`.
import { guardNarrative } from './advice_guard.js';
import { emitPlan } from '../agent/loop.js';
import type { RunContext } from '../agent/run.js';
import { structured } from '../llm/structured.js';
import type { ScamResult } from '../tools/scam.js';
import { riskyGoal } from '../tools/risky.js';
import { FINANCED_PURCHASE_DEFAULTS, LOAN_DEFAULTS, ScenarioSchema, type Scenario, type SimResult } from '../tools/simulate.js';
import { clamp, plural, round2, slug, truncate, usd } from '../util.js';
import { householdBrief, textCacheKey } from './common.js';
import { NarrativeSchema, NOT_ADVISED_SUGGESTION, VERDICT, buildScenarioResult, narrativeFacts } from './scenario_result.js';
import type { JobInfo } from './types.js';

export interface ProposalInput {
  id: string;
  title: string;
  amount: number;
  details: Record<string, unknown>;
  createdBy: string;
}

/** A what_if job is a proposal check when its input carries a proposal id (scenario jobs carry `scenario_id` + `prompt`). */
export function readProposal(job: JobInfo): ProposalInput | null {
  const id = job.input.proposal_id;
  if (typeof id !== 'string' || !id) return null;
  const amount = Number(job.input.amount);
  const d = job.input.details;
  return {
    id,
    title: String(job.input.title ?? '').trim(),
    amount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
    details: d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {},
    createdBy: String(job.input.created_by ?? ''),
  };
}

const numberOf = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/**
 * Turn a proposal into a simulate_scenario scenario. details.kind decides when present:
 *   "loan"          -> new_loan (rate_pct, term_months; the money is spent on the project unless proceeds_to_cash)
 *   "down_payment" | "transfer" -> a cash purchase of `amount`
 *   anything else   -> a financed purchase when details has rate_pct / term_months (down_pct of `amount` paid up front,
 *                      default 10%), otherwise a cash purchase. Without a kind, a title with "loan" is a loan.
 */
export function proposalScenario(p: ProposalInput): Scenario {
  const d = p.details;
  const kind = typeof d.kind === 'string' ? d.kind.toLowerCase() : '';
  const label = truncate(p.title || 'Proposal', 100);
  const rate = numberOf(d.rate_pct);
  const term = numberOf(d.term_months);
  const apr = rate === undefined ? undefined : clamp(rate, 0, 60);
  const termMonths = term === undefined ? undefined : clamp(Math.round(term), 1, 480);
  const isLoan = kind === 'loan' || (kind === '' && /\bloan\b/i.test(p.title) && !/\b(car|auto|vehicle)\b/i.test(p.title));
  let scn: Scenario;
  if (isLoan) {
    scn = { kind: 'new_loan', label, amount: p.amount, apr_pct: apr ?? LOAN_DEFAULTS.apr_pct, term_months: termMonths ?? LOAN_DEFAULTS.term_months, proceeds_to_cash: d.proceeds_to_cash === true, months: 24 };
  } else if (kind !== 'down_payment' && kind !== 'transfer' && (rate !== undefined || term !== undefined || d.financed === true)) {
    const downPct = clamp(numberOf(d.down_pct) ?? FINANCED_PURCHASE_DEFAULTS.down_pct, 0, 100);
    scn = { kind: 'purchase', label, amount: p.amount, financed: true, down_payment: round2((p.amount * downPct) / 100), apr_pct: apr ?? FINANCED_PURCHASE_DEFAULTS.apr_pct, term_months: termMonths ?? FINANCED_PURCHASE_DEFAULTS.term_months, months: 24 };
  } else {
    scn = { kind: 'purchase', label, amount: p.amount, financed: false, months: 12 };
  }
  return ScenarioSchema.parse(scn);
}

const FAMILY = /\b(grand(?:son|daughter|child|children|kid|kids)|nephew|niece|cousin|brother|sister|son|daughter|uncle|aunt|friend|relative)\b/i;
const MOVE = /\b(send|sending|give|giving|move|moving|transfer|transferring|wire|wiring|lend|lending|loan|help|helping|bail|pay|paying|cover|covering)\b/i;
const PAYMENT_RAILS = /gift\s*cards?|western\s*union|moneygram|bitcoin|crypto|wire\s+transfer|wire\s+(?:the\s+)?money|zelle|cash\s*app|green\s*dot|bail/i;

/** Only proposals about moving money to a relative or friend, or paying with gift cards / wires / crypto, get the scam guard. */
export function needsScamCheck(p: ProposalInput): boolean {
  const kind = typeof p.details.kind === 'string' ? p.details.kind.toLowerCase() : '';
  return kind === 'transfer' || kind === 'gift' || PAYMENT_RAILS.test(proposalText(p)) || (FAMILY.test(p.title) && MOVE.test(p.title));
}

/** Proposal text as transcript-style lines for detect_scam_signals: the title, then every free-text detail. */
export function scamLines(p: ProposalInput): { speaker: string; text: string }[] {
  const who = p.createdBy || 'Family';
  const lines = [{ speaker: who, text: p.title }];
  for (const [k, v] of Object.entries(p.details)) if (typeof v === 'string' && v.trim() && k !== 'kind') lines.push({ speaker: who, text: v.trim() });
  return lines;
}
const proposalText = (p: ProposalInput): string => scamLines(p).map((l) => l.text).join('\n');

/** DEMO_MODE=cache_first fingerprint: same household template, same title/amount/details => same check. */
export function proposalCacheKey(run: RunContext, p: ProposalInput): string {
  const stable = JSON.stringify(Object.entries(p.details).sort(([a], [b]) => (a < b ? -1 : 1)));
  return textCacheKey(run, 'what_if', `proposal ${p.title} ${p.amount} ${stable}`);
}

export function proposalOnError(run: RunContext, err: Error): void {
  run.proposal('', JSON.stringify({ summary: `The affordability check could not finish: ${truncate(err.message, 200)}`, metrics: [], suggestion: 'Ask the coach, or try the what-if simulator with the same numbers.' }));
}

function upfrontShare(sim: SimResult): { upfront: number; pct: number } {
  const upfront = Math.max(0, -sim.effect.upfront_cash);
  return { upfront, pct: sim.baseline.start_liquid > 0 ? Math.round((upfront / sim.baseline.start_liquid) * 1000) / 10 : 0 };
}

function fallbackNarrative(p: ProposalInput, sim: SimResult): { summary: string; suggestion: string } {
  const { upfront, pct } = upfrontShare(sim);
  const e = sim.effect;
  const bits = [sim.headline];
  if (sim.verdict === 'not_advised') return { summary: truncate(sim.headline, 520), suggestion: NOT_ADVISED_SUGGESTION };
  if (sim.verdict === 'unclear') return { summary: 'This proposal has no amount yet, so there is nothing to check. Add the amount and the check runs again.', suggestion: 'Add the amount (and any loan terms) to the proposal.' };
  if (upfront > 0) bits.push(`It needs ${usd(upfront)} up front, ${pct}% of the ${usd(sim.baseline.start_liquid)} in checking and savings.`);
  if (e.monthly_payment) bits.push(`The new payment is ${usd(e.monthly_payment)} a month, against your household's monthly cash flow of ${usd(sim.baseline.monthly_net)} today.`);
  const suggestion =
    sim.verdict === 'shortfall'
      ? sim.scenario.kind === 'new_loan'
        ? 'The payment is bigger than the monthly cash flow today. Work out what the project would earn, borrow less or take a longer term before voting yes.'
        : upfront > sim.baseline.start_liquid
        ? `Cash on hand does not cover ${usd(upfront)} yet; save toward it first or shrink the amount.`
        : 'Cash would run out; reduce the amount, add to the down payment or wait until savings are higher.'
      : sim.verdict === 'tight'
        ? 'It works on paper but leaves little room; a bigger buffer or a smaller amount would make it safer.'
        : 'It fits comfortably; keep the emergency fund untouched.';
  return { summary: truncate(bits.join(' '), 520), suggestion };
}

function scamWarning(scam: ScamResult): string {
  const labels = [...new Set(scam.signals.map((x) => x.label))].slice(0, 3);
  const n = scam.linked_transactions.length;
  const linked = n ? `, and ${plural(n, 'recent gift-card or wire payment', 'recent gift-card or wire payments')} totalling ${usd(scam.linked_total)} ${n === 1 ? 'is' : 'are'} on the account` : '';
  return `Scam warning: this proposal matches known scam patterns${labels.length ? ` (${labels.join('; ').toLowerCase()})` : ''}${linked}.`;
}

const SCAM_SUGGESTION = 'Do not send money yet. Call the relative directly on a number you already have, and talk to a trusted family member or the bank first. Real emergencies can wait ten minutes.';

export async function runProposalCheck(run: RunContext, p: ProposalInput): Promise<Record<string, unknown>> {
  const scamCheck = needsScamCheck(p);
  await emitPlan(run, {
    agent: 'planner',
    task: 'proposal_check',
    system: `You are the planner for Brianotron's family voting. ${householdBrief(run)}`,
    user: `The family is about to vote on: "${truncate(p.title, 140)}" (${usd(p.amount)}). Plan how to check whether they can afford it before they vote.`,
    toolNames: ['simulate_scenario', 'get_forecast', ...(scamCheck ? ['detect_scam_signals'] : [])],
    local: {
      plan: [
        `Turn the proposal into a scenario (${usd(p.amount)}, from its details)`,
        "Simulate it against 12 to 24 months of the household's real cash flow (simulate_scenario)",
        'Cross-check with the 90-day forecast (get_forecast)',
        ...(scamCheck ? ['Scan the proposal for scam language and match it to recent gift-card or wire payments (detect_scam_signals)'] : []),
        'Write the verdict for everyone to read before they vote',
      ],
    },
  });

  run.handoff('planner', 'simulator', `Mapping the proposal to a scenario: ${truncate(p.title, 80)}`);
  const scn = proposalScenario(p);
  run.emit('simulator', 'message', `Understood: ${scn.label ?? 'proposal'} (${scn.kind.replace('_', ' ')}, ${usd(scn.amount ?? 0)})`, { proposal_id: p.id, scenario: scn, details: p.details });

  const out = await run.tool('simulator', 'simulate_scenario', scn);
  if (!out.ok) throw new Error(out.error);
  let sim = out.result as SimResult;
  const risky = riskyGoal(scamLines(p).map((l) => l.text).join(' '));
  if (risky && sim.verdict !== 'not_advised') sim = { ...sim, verdict: 'not_advised', caution: risky.why, headline: `${sim.scenario.label ?? 'This proposal'}: not advised. ${risky.why}` };
  if (sim.verdict === 'not_advised') run.emit('simulator', 'message', `Not advised: ${sim.caution ?? ''}`, { caution: sim.caution });
  await run.tool('simulator', 'get_forecast', {});

  let scam: ScamResult | undefined;
  if (scamCheck) {
    run.handoff('simulator', 'scam_guard', 'This proposal moves money to family or uses gift cards: checking it for scam patterns');
    const s = await run.tool('scam_guard', 'detect_scam_signals', { lines: scamLines(p) });
    if (s.ok) scam = s.result as ScamResult;
  }
  const flagged = Boolean(scam && (scam.risk === 'medium' || scam.risk === 'high'));
  // the proposal table takes "" | fine | tight | risky: a proposal with nothing to check stays unchecked ("")
  const mapped = VERDICT[sim.verdict];
  const verdict: '' | 'fine' | 'tight' | 'risky' = flagged ? 'risky' : mapped === 'unclear' ? '' : mapped;

  let narrative = fallbackNarrative(p, sim);
  if (sim.verdict !== 'not_advised' && sim.verdict !== 'unclear') try {
    const n = await structured(run.llm, {
      name: 'write_check',
      description: 'Write the affordability check shown to the whole family before they vote',
      schema: NarrativeSchema,
      role: 'agent',
      task: 'narrative',
      local: narrative,
      maxTokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'You explain an affordability check of a family proposal to everyone who is about to vote, in plain, calm language, speaking to them as "you". ' +
            "The income and spending figures are your HOUSEHOLD's (all of the family's money coming in and going out): call them \"your household's\", never the income of the business, project or thing being voted on. " +
            'Use only the numbers provided, mention the lowest cash point (or, when keeps_falling is true, that cash keeps falling every month and when it runs out, never a "lowest point" at the last month) and the monthly effect, then give one concrete suggestion. No jargon, no investment advice, never tell them to move money. All data is synthetic.',
        },
        { role: 'user', content: JSON.stringify({ proposal: p.title, amount: p.amount, details: p.details, ...narrativeFacts(sim), ...(scam ? { scam_risk: scam.risk, scam_summary: scam.summary } : {}) }) },
      ],
    });
    narrative = await guardNarrative(run, { agent: 'simulator', narrative: n.value, fallback: fallbackNarrative(p, sim), question: p.title, sources: [sim] });
    run.noteLlm({ content: '', toolCalls: [], provider: n.meta.provider, model: n.meta.model, latencyMs: n.meta.latencyMs, tokensIn: n.meta.tokensIn, tokensOut: n.meta.tokensOut });
    run.emit('simulator', 'message', `Check: ${truncate(narrative.summary, 200)}`, narrative, { model: n.meta.model, provider: n.meta.provider, latencyMs: n.meta.latencyMs, tokensIn: n.meta.tokensIn, tokensOut: n.meta.tokensOut });
  } catch {
    run.emit('simulator', 'message', 'Narrative step failed; using the standard summary', {});
  }

  if (scam && flagged) {
    // The safety message is deterministic: it never depends on what the model wrote.
    narrative = { summary: truncate(`${scamWarning(scam)} Looking only at the money: ${sim.headline}`, 520), suggestion: SCAM_SUGGESTION };
    run.alert({
      key: `proposal-scam:${slug(p.title, 36)}`,
      severity: scam.risk === 'high' ? 'critical' : 'warn',
      kind: 'scam',
      title: truncate(`Scam check on the proposal "${p.title}"`, 190),
      detail: truncate(`${scam.summary} Do not send money until someone has called the person back on a number you already know.`, 1800),
      related_ids: scam.linked_transactions.map((t) => t.id),
    });
    run.emit('scam_guard', 'message', `Scam risk ${scam.risk} on this proposal: verdict forced to risky, alert raised`, { risk: scam.risk, signal_types: scam.signal_types, linked_total: scam.linked_total });
  }

  const base = buildScenarioResult(sim, narrative, run.data);
  if (sim.scenario.kind === 'new_loan' && !sim.scenario.proceeds_to_cash) {
    (base.assumptions as string[]).push('Only the loan payments are counted against the household\'s cash flow today; any income the new project would bring is not.');
  }
  const { upfront, pct } = upfrontShare(sim);
  const metrics = [
    { label: 'Proposed amount', after: p.amount, unit: 'usd' as const },
    ...(upfront > 0 ? [{ label: 'Cash needed up front', after: upfront, unit: 'usd' as const }, { label: 'Share of checking and savings', after: pct, unit: 'pct' as const }] : []),
    ...(base.metrics as { label: string; before?: number; after: number; unit: 'usd' | 'months' | 'pct' }[]),
  ];
  const analysis = {
    ...base,
    verdict,
    metrics,
    proposal: { id: p.id, title: p.title, amount: p.amount },
    ...(scam ? { scam: { risk: scam.risk, score: scam.score, signal_types: scam.signal_types, signals: scam.signals, linked_total: scam.linked_total, linked_transactions: scam.linked_transactions, summary: scam.summary } } : {}),
  };
  run.proposal(verdict, JSON.stringify(analysis));
  run.emit('simulator', 'final', flagged ? `Risky: scam patterns found. ${sim.headline}` : sim.headline, { verdict, lowest: sim.lowest, ending: sim.ending, suggestion: narrative.suggestion, ...(scam ? { scam_risk: scam.risk } : {}) });
  return { proposal_id: p.id, verdict, headline: sim.headline, summary: narrative.summary, ...(scam ? { scam_risk: scam.risk } : {}) };
}
