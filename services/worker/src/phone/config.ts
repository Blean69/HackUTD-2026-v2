// Phone/voice configuration (env only, nothing here is a secret default).
//   VOICE_SHARED_SECRET   header value the voice service sends as x-voice-secret on every /phone/* call (required)
//   PHONE_PINS            keypad PINs for the phone path: "1234:hh_rivera,5678:hh_nguyen" (optionally "1234:hh_rivera:mem_rivera_marisol")
//   VOICE_ENABLED         "0" switches the whole /phone/* surface off (kill switch), anything else = on
//   PHONE_MAX_SESSIONS    concurrent live calls (default 4)
//   PHONE_IDLE_REAP_SECS  finish a call with no traffic as error "abandoned" (default 600)
//   PHONE_MAX_CALL_SECS   hard backstop on call length enforced by the worker (default 900; the voice service enforces its own, shorter cap)
export interface PinEntry {
  householdId: string;
  memberId: string;
}

export interface PhoneConfig {
  enabled: boolean;
  secret: string;
  pins: Map<string, PinEntry>;
  pinTries: number;
  maxSessions: number;
  idleReapMs: number;
  maxCallMs: number;
  maxEventsPerRun: number;
}

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** "1234:hh_rivera, 5678:hh_nguyen:mem_x" -> Map(pin -> {householdId, memberId}). Bad entries are skipped. */
export function parsePins(text: string | undefined): Map<string, PinEntry> {
  const out = new Map<string, PinEntry>();
  for (const raw of (text ?? '').split(/[\s,;]+/)) {
    const [pin, householdId, memberId = ''] = raw.split(':').map((s) => s.trim());
    if (!pin || !householdId || !/^\d{4,8}$/.test(pin)) continue;
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(householdId) || !/^[A-Za-z0-9_.-]{0,80}$/.test(memberId)) continue;
    if (!out.has(pin)) out.set(pin, { householdId, memberId });
  }
  return out;
}

export function loadPhoneConfig(env: NodeJS.ProcessEnv = process.env): PhoneConfig {
  return {
    enabled: (env.VOICE_ENABLED ?? '1').trim() !== '0',
    secret: (env.VOICE_SHARED_SECRET ?? '').trim(),
    pins: parsePins(env.PHONE_PINS),
    pinTries: Math.floor(num(env.PHONE_PIN_TRIES, 3)),
    maxSessions: Math.floor(num(env.PHONE_MAX_SESSIONS, 4)),
    idleReapMs: num(env.PHONE_IDLE_REAP_SECS, 600) * 1000,
    maxCallMs: num(env.PHONE_MAX_CALL_SECS, 900) * 1000,
    maxEventsPerRun: Math.floor(num(env.PHONE_MAX_EVENTS, 600)),
  };
}
