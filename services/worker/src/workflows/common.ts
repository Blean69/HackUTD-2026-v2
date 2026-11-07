import { structured } from '../llm/structured.js';
import type { RunContext } from '../agent/run.js';
import { meta } from '../agent/run.js';
import { makeCacheKey, normalizeText } from '../agent/cache.js';
import { z } from 'zod';
import { sha1, truncate, usd } from '../util.js';
import type { Finding } from '../tools/anomalies.js';

export function makeKey(run: RunContext, workflow: string, fingerprint: string): string {
  return makeCacheKey(workflow, templateOf(run), fingerprint);
}

export const templateOf = (run: RunContext): string => run.data.household.template_id || run.data.household.id;

export function householdBrief(run: RunContext): string {
  const h = run.data.household;
  return `${h.name} (${h.city}, ${h.state}). ${truncate(h.persona, 400)} Today is ${run.data.asOf}.`;
}

export function textCacheKey(run: RunContext, workflow: string, text: string): string {
  return makeCacheKey(workflow, templateOf(run), normalizeText(text));
}

/** Fingerprint of the household's ledger (ids ignored so a sandbox copy equals its template). */
export function ledgerFingerprint(run: RunContext): string {
  const rows = run.data.txns.map((t) => `${t.date}|${t.amount}|${t.merchant}|${t.category}`).sort();
  const bal = run.data.accounts.map((a) => `${a.type}|${a.balance}`).sort();
  return sha1(`${rows.join('\n')}\n${bal.join('\n')}`);
}

const RULE_TEXT: Record<string, { title: string; detail: (n: number, ex: Finding) => string }> = {
  impossible_value: { title: 'Impossible amounts or dates in the ledger', detail: (n, e) => `${n} transaction(s) have values that cannot be real (for example ${e.merchant}: ${e.reason}). They are excluded from the health math until fixed.` },
  duplicate: { title: 'Possible duplicate charges', detail: (n, e) => `${n} charge(s) appear twice in a row (for example ${e.merchant} ${usd(Math.abs(e.amount))} on ${e.date}). If they are import errors, remove one of each pair.` },
  garbled: { title: 'Merchant names that look corrupted', detail: (n, e) => `${n} transaction(s) have unreadable merchant names (for example "${e.merchant.slice(0, 30)}"). Category totals may be off until they are cleaned up.` },
  card_testing: { title: 'Burst of tiny charges (card testing)', detail: (n) => `${n} charges under $2 landed close together, a pattern fraudsters use to test stolen card numbers. Freeze or replace the card and review the account.` },
  scam_payment: { title: 'Gift-card, wire or crypto payment of scam size', detail: (n, e) => `${n} payment(s) look like scam payments (for example ${usd(Math.abs(e.amount))} to ${e.merchant} on ${e.date}). Confirm with the family that these were intended, and report them to the bank if not.` },
  account_takeover: { title: 'Large payment after a new payee or password change', detail: (n, e) => `${n} large payment(s) follow signs of an account change (for example ${usd(Math.abs(e.amount))} to ${e.merchant}). Call the bank on a number you trust.` },
  outlier: { title: 'Unusually large purchases', detail: (n, e) => `${n} purchase(s) are far above normal for this household (for example ${usd(Math.abs(e.amount))} at ${e.merchant}). Worth a quick look.` },
};

export interface FindingGroup {
  rule: string;
  kind: Finding['kind'];
  severity: Finding['severity'];
  findings: Finding[];
}

export function groupFindings(findings: Finding[]): FindingGroup[] {
  const by = new Map<string, FindingGroup>();
  for (const f of findings) {
    const g = by.get(f.rule) ?? { rule: f.rule, kind: f.kind, severity: f.severity, findings: [] };
    g.findings.push(f);
    by.set(f.rule, g);
  }
  const rank = { critical: 3, warn: 2, info: 1 } as const;
  return [...by.values()].sort((a, b) => rank[b.severity] - rank[a.severity]);
}

const ExplainSchema = z.object({
  items: z.array(z.object({ rule: z.string(), title: z.string().min(3).max(90), detail: z.string().min(10).max(320) })).max(8),
});

/** Ask the model to explain grouped findings in plain English; fall back to deterministic text per rule. */
export async function explainGroups(run: RunContext, agent: string, groups: FindingGroup[], task: string): Promise<Map<string, { title: string; detail: string }>> {
  const base = new Map<string, { title: string; detail: string }>();
  for (const g of groups) {
    const t = RULE_TEXT[g.rule] ?? { title: g.rule, detail: (n: number) => `${n} finding(s).` };
    base.set(g.rule, { title: t.title, detail: t.detail(g.findings.length, g.findings[0]!) });
  }
  if (!groups.length) return base;
  try {
    const facts = groups.map((g) => ({ rule: g.rule, count: g.findings.length, examples: g.findings.slice(0, 3).map((f) => ({ merchant: f.merchant, amount: f.amount, date: f.date, why: f.reason })) }));
    const r = await structured(run.llm, {
      name: 'explain_findings',
      description: 'Plain-English alert text for each group of suspicious or messy transactions',
      schema: ExplainSchema,
      role: 'fast',
      task: `${task}.explain`,
      local: { text: '' },
      messages: [
        { role: 'system', content: 'You are a bank data auditor writing alerts a non-expert family can understand. For each rule group write a short title (max 80 chars) and a 1-2 sentence detail with the key dollar figure and one recommended action. Do not invent facts beyond the findings. All data is synthetic.' },
        { role: 'user', content: `Findings by rule:\n${JSON.stringify(facts)}` },
      ],
    });
    run.noteLlm({ content: '', toolCalls: [], provider: r.meta.provider, model: r.meta.model, latencyMs: r.meta.latencyMs, tokensIn: r.meta.tokensIn, tokensOut: r.meta.tokensOut });
    run.emit(
      agent,
      'message',
      r.meta.provider === 'local' ? 'Using standard alert wording (offline rule-based fallback)' : `Wrote plain-English explanations for ${r.value.items.length} finding group(s)`,
      { items: r.value.items },
      { model: r.meta.model, provider: r.meta.provider, latencyMs: r.meta.latencyMs, tokensIn: r.meta.tokensIn, tokensOut: r.meta.tokensOut },
    );
    // the local provider returns an empty list for this task, so deterministic text stays in place there
    for (const it of r.value.items) if (base.has(it.rule)) base.set(it.rule, { title: it.title, detail: it.detail });
  } catch (e) {
    run.emit(agent, 'message', `Explanation step failed (${truncate(e instanceof Error ? e.message : String(e), 100)}); using standard wording`, {});
  }
  return base;
}

export { meta };
