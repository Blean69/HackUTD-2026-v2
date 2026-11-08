// data_quality and scam_check: run the detectors, explain the hits in plain English, create alerts.
import { emitPlan } from '../agent/loop.js';
import { detectAnomalies, type AnomalyRule, type Finding } from '../tools/anomalies.js';
import type { ScamResult } from '../tools/scam.js';
import { plural, truncate, usd } from '../util.js';
import { explainGroups, groupFindings, householdBrief, ledgerFingerprint, makeKey } from './common.js';
import type { WorkflowDef } from './types.js';

const SCAM_RULES = new Set<AnomalyRule>(['scam_payment', 'card_testing', 'account_takeover']);
/** Rules recompute_household already turns into per-transaction alerts. */
const DB_RULES = new Set<string>(['impossible_value', 'duplicate', 'garbled', 'card_testing']);

export const dataQualityWorkflow: WorkflowDef = {
  name: 'data_quality',

  async cacheKey(run) {
    return makeKey(run, 'data_quality', ledgerFingerprint(run));
  },

  async run(run) {
    await emitPlan(run, {
      agent: 'data_auditor',
      task: 'data_quality',
      system: `You are Brianotron's data auditor. ${householdBrief(run)}`,
      user: 'A new household copy was just created. Find data-quality problems and suspicious transactions and explain them.',
      toolNames: ['detect_transaction_anomalies', 'get_accounts'],
      local: { plan: ['Scan every transaction for duplicates, garbled merchants, impossible values and fraud patterns (detect_transaction_anomalies)', 'Group the hits by rule', 'Explain each group in plain English', 'Create one alert per group'] },
    });
    const out = await run.tool('data_auditor', 'detect_transaction_anomalies', { limit: 30 });
    if (!out.ok) throw new Error(out.error);
    const all = (out.result as { findings: Finding[] }).findings;
    const groups = groupFindings(all);
    if (!groups.length) {
      run.emit('data_auditor', 'final', 'No data-quality problems found', { findings: 0 });
      return { alerts: [], findings: 0 };
    }
    const text = await explainGroups(run, 'data_auditor', groups, 'data_quality');
    const made: string[] = [];
    // recompute_household already raises one rule alert per transaction for these; add ONE plain-English summary instead of duplicating them
    const covered = groups.filter((g) => DB_RULES.has(g.rule));
    const extra = groups.filter((g) => !DB_RULES.has(g.rule));
    if (covered.length) {
      const total = covered.reduce((n, g) => n + g.findings.length, 0);
      const sev = covered.some((g) => g.severity === 'critical') ? 'critical' : covered.some((g) => g.severity === 'warn') ? 'warn' : 'info';
      const title = `Data audit: ${total} issue${total === 1 ? '' : 's'} in the ledger, explained`;
      const detail = covered.map((g) => `${text.get(g.rule)!.title}: ${text.get(g.rule)!.detail}`).join(' ');
      run.alert({ key: 'dq:summary', severity: sev, kind: 'data_quality', title, detail: truncate(detail, 1900), related_ids: covered.flatMap((g) => g.findings.slice(0, 5).map((f) => f.txn_id)).slice(0, 20) });
      made.push(title);
      run.emit('data_auditor', 'message', `Summary alert: ${title}`, { rules: covered.map((g) => g.rule) });
    }
    for (const g of extra) {
      const t = text.get(g.rule)!;
      run.alert({ key: `dq:${g.rule}`, severity: g.severity, kind: g.kind, title: truncate(t.title, 190), detail: truncate(t.detail, 1800), related_ids: g.findings.slice(0, 12).map((f) => f.txn_id) });
      made.push(t.title);
      run.emit('data_auditor', 'message', `Alert: ${t.title} (${g.findings.length})`, { rule: g.rule, severity: g.severity, txn_ids: g.findings.slice(0, 6).map((f) => f.txn_id) });
    }
    run.emit('data_auditor', 'final', `Created ${plural(made.length, 'alert')} from ${plural(all.length, 'suspicious transaction')}`, { alerts: made });
    return { alerts: made, findings: all.length };
  },
};

export const scamCheckWorkflow: WorkflowDef = {
  name: 'scam_check',

  async cacheKey(run, job) {
    return makeKey(run, 'scam_check', `${ledgerFingerprint(run)}|${String(job.input.text ?? '')}`);
  },

  async run(run, job) {
    const text = String(job.input.text ?? '').trim();
    await emitPlan(run, {
      agent: 'scam_guard',
      task: 'scam_check',
      system: `You are Brianotron's scam guard. ${householdBrief(run)}`,
      user: text ? `Check this message or call description for scams: "${truncate(text, 400)}" and compare with recent payments.` : 'Check the recent payments for scam patterns such as gift cards, wires or card testing.',
      toolNames: ['detect_scam_signals', 'detect_transaction_anomalies'],
      local: { plan: [...(text ? ['Scan the text for scam language (detect_scam_signals)'] : []), 'Look for gift-card, wire, crypto and card-testing payments (detect_transaction_anomalies)', 'Explain any hit in plain English and alert the family'] },
    });
    let scam: ScamResult | undefined;
    if (text) {
      const s = await run.tool('scam_guard', 'detect_scam_signals', { text });
      if (s.ok) scam = s.result as ScamResult;
    }
    const a = await run.tool('scam_guard', 'detect_transaction_anomalies', { limit: 30 });
    const findings = a.ok ? (a.result as { findings: Finding[] }).findings.filter((f) => SCAM_RULES.has(f.rule)) : [];
    const groups = groupFindings(findings);
    const made: string[] = [];
    if (scam && scam.risk !== 'none') {
      const title = scam.linked_transactions.length ? `Scam warning: matches ${usd(scam.linked_total)} in recent payments` : 'Scam warning: this message looks like a known scam';
      run.alert({ key: `scam-text:${String(job.subjectId)}`, severity: scam.risk === 'high' ? 'critical' : 'warn', kind: 'scam', title, detail: truncate(scam.summary, 1500), related_ids: scam.linked_transactions.map((t) => t.id) });
      made.push(title);
    }
    if (groups.length) {
      const textMap = await explainGroups(run, 'scam_guard', groups, 'scam_check');
      for (const g of groups) {
        const t = textMap.get(g.rule)!;
        run.alert({ key: `scan:${g.rule}`, severity: g.severity, kind: g.kind, title: truncate(t.title, 190), detail: truncate(t.detail, 1800), related_ids: g.findings.slice(0, 12).map((f) => f.txn_id) });
        made.push(t.title);
      }
    }
    run.emit('scam_guard', 'final', made.length ? `Raised ${plural(made.length, 'scam alert')}` : 'No scam patterns found', { alerts: made });
    return { alerts: made };
  },
};

export { detectAnomalies };
