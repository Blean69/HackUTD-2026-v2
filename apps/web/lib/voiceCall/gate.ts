/**
 * Pure decisions behind hold-to-talk and the speakerphone guard. No browser APIs in here so it can be unit tested
 * with plain `node --test` (see gate.test.mjs).
 */

/** Keep the mic open this long after the button is released so the last syllable is not clipped. */
export const RELEASE_TAIL_MS = 250;
/** Keep the mic closed this long after the bot reports it stopped talking: its audio is still playing out of the speaker. */
export const BOT_TAIL_MS = 400;
/** After "Interrupt" the mic stays live this long, or until the person finishes a turn, whichever is first. */
export const INTERRUPT_WINDOW_MS = 12_000;
/** A held talk button that never reports release (lost pointer) is let go of after this long. */
export const HOLD_FAILSAFE_MS = 120_000;

export interface GateInput {
  /** The person pressed Mute. Always wins. */
  muted: boolean;
  /** Hold-to-talk mode is on. */
  pushToTalk: boolean;
  /** The talk button is down (or inside its short release tail). */
  held: boolean;
  /** Speakerphone guard is on. */
  halfDuplex: boolean;
  /** The bot is speaking (RTVI bot-started-speaking .. bot-stopped-speaking plus tail). */
  botSpeaking: boolean;
  /** "Interrupt" was tapped and its window has not ended. */
  interrupted: boolean;
}

/**
 * Should the outgoing mic track carry sound right now?
 *  - Mute wins over everything.
 *  - Hold-to-talk: only while held. Holding while the bot talks is a deliberate barge-in, so the guard does not apply.
 *  - Otherwise the speakerphone guard closes the mic while the bot talks, unless the person tapped Interrupt.
 */
export function micGateOpen(i: GateInput): boolean {
  if (i.muted) return false;
  if (i.pushToTalk) return i.held;
  if (i.halfDuplex && i.botSpeaking && !i.interrupted) return false;
  return true;
}

/**
 * How long a "bot is speaking" flag may go without any audible bot audio before we stop believing it (a lost
 * bot-stopped-speaking event would otherwise leave the mic closed for good). Short when we can actually hear the remote
 * level; long when we cannot (AudioContext suspended on iOS), so a slow answer is never cut into by the watchdog.
 */
export function botStuckAfterMs(canMeasureRemoteLevel: boolean): number {
  return canMeasureRemoteLevel ? 4_000 : 45_000;
}
