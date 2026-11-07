// Huddles: opt-in, consent-gated live sessions. The transcript is purged by the worker after analysis.
import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { callerName, cleanText, enqueueJob, fail, newId, parseJsonArray, requireHousehold } from '../util';

const MAX_LINE = 2000;

export const start_huddle = spacetimedb.reducer(
  { household_id: t.string(), consent_names_json: t.string() },
  (ctx, { household_id, consent_names_json }) => {
    requireHousehold(ctx, household_id);
    const names = parseJsonArray(consent_names_json, 'consent_names_json')
      .map((n) => (typeof n === 'string' ? n.trim() : ''))
      .filter((n) => n.length > 0)
      .map((n) => n.slice(0, 40));
    if (names.length === 0) fail('Recording needs consent: pass at least one name in consent_names_json');

    // Several phones may press "start" at once: join the huddle that is already live instead of opening a second.
    for (const h of ctx.db.huddle.household_id.filter(household_id)) {
      if (h.status !== 'live') continue;
      let merged = names;
      try {
        const prev: unknown = JSON.parse(h.consent_names_json);
        if (Array.isArray(prev)) merged = [...new Set([...prev.map(String), ...names])];
      } catch {
        merged = names;
      }
      ctx.db.huddle.id.update({ ...h, consent_names_json: JSON.stringify(merged) });
      return;
    }

    const id = newId(ctx, 'hud_', (x) => !!ctx.db.huddle.id.find(x));
    ctx.db.huddle.insert({
      id,
      household_id,
      started_by_name: callerName(ctx, names[0]),
      status: 'live',
      started_at: ctx.timestamp,
      ended_at: undefined,
      consent_names_json: JSON.stringify([...new Set(names)]),
    });
  },
);

export const append_transcript = spacetimedb.reducer(
  { huddle_id: t.string(), speaker: t.string(), text: t.string() },
  (ctx, { huddle_id, speaker, text }) => {
    const h = ctx.db.huddle.id.find(huddle_id);
    if (!h) fail(`unknown huddle "${huddle_id}"`);
    if (h.status !== 'live') fail('this huddle is no longer live');
    ctx.db.transcript_line.insert({
      id: 0n,
      huddle_id,
      household_id: h.household_id,
      speaker: cleanText(speaker, 'speaker', 60, true) || 'Speaker',
      text: cleanText(text, 'text', MAX_LINE),
      ts: ctx.timestamp,
    });
  },
);

export const end_huddle = spacetimedb.reducer({ huddle_id: t.string() }, (ctx, { huddle_id }) => {
  const h = ctx.db.huddle.id.find(huddle_id);
  if (!h) fail(`unknown huddle "${huddle_id}"`);
  if (h.status !== 'live') return; // a second phone pressing "end" is a no-op
  ctx.db.huddle.id.update({ ...h, status: 'analyzing', ended_at: ctx.timestamp });

  let consent: unknown = [];
  try {
    consent = JSON.parse(h.consent_names_json);
  } catch {
    consent = [];
  }
  let lines = 0;
  for (const _ of ctx.db.transcript_line.huddle_id.filter(huddle_id)) lines++;
  enqueueJob(ctx, 'huddle', h.household_id, huddle_id, { huddle_id, consent_names: consent, transcript_lines: lines });
});
