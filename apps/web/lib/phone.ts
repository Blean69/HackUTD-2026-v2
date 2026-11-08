/**
 * "Call Brian by phone" (docs/contracts.md section 8): the phone number and the rules for a household's 5-digit code.
 * The module is the source of truth for the rules (spacetime/src/phone.ts); the checks here only give instant feedback.
 */

/**
 * The phone line's number, E.164. `NEXT_PUBLIC_PHONE_NUMBER` is inlined at build time (Dockerfile build arg); unset means the
 * team's SignalWire line, and an explicitly empty value hides every phone surface.
 */
const RAW_NUMBER = process.env.NEXT_PUBLIC_PHONE_NUMBER;
// Calls to Brian start in the app (the Talk button, or an incoming call from him). A phone number only shows if the deployment sets one.
export const PHONE_NUMBER: string = normalizePhone(RAW_NUMBER === undefined ? "" : RAW_NUMBER);

/** Keep a leading + and the digits: "+1 (844) 468-1795" -> "+18444681795". "" when there is nothing usable. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return `${raw.trim().startsWith("+") ? "+" : digits.length === 10 ? "+1" : "+"}${digits}`;
}

/** "+18444681795" -> "+1 (844) 468-1795". Numbers outside the US/Canada plan come back as typed, digits grouped loosely. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export const PHONE_DISPLAY = formatPhone(PHONE_NUMBER);
export const PHONE_HREF = PHONE_NUMBER ? `tel:${PHONE_NUMBER}` : "";

export const PIN_LENGTH = 5;

/** Why a code is too easy to guess, or "" when it is fine. Mirrors weakPinReason in spacetime/src/phone.ts. */
export function weakPinReason(pin: string): string {
  if (!/^\d+$/.test(pin) || pin.length < 2) return "";
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return "Pick a code that isn't the same digit repeated.";
  const deltas = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
  if (deltas.every((x) => x === 1)) return "Pick a code that doesn't count straight up, like 12345.";
  if (deltas.every((x) => x === 9)) return "Pick a code that doesn't count straight down, like 54321.";
  if (d.every((x, i) => x === d[i % 2])) return "Pick a code that doesn't just alternate two digits.";
  return "";
}

/** Reducer errors are short sentences from the module; make them read like the rest of the app. */
export function friendlyPhoneError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const m = raw.toLowerCase();
  if (m.includes("already taken")) return "That code is already taken. Pick a different one.";
  if (m.includes("exactly 5 digits")) return "Use exactly 5 digits.";
  if (m.includes("can not")) return "That code is too easy to guess. Pick a different one.";
  if (m.includes("only the household owner")) return "Only the person who set up this household can change its phone code.";
  if (m.includes("join this household room")) return "Open this household's room first, then try again.";
  if (m.includes("unknown household")) return "We can't find that household.";
  if (!raw || m.includes("not ready") || m.includes("failed to fetch") || m.includes("disconnected")) return "We couldn't reach the database. Check your connection and try again.";
  return "We couldn't save that code. Please try again.";
}
