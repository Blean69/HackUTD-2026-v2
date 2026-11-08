/**
 * Microphone capture settings shared by every browser mic path (Table Mode in `lib/voice.ts`, the Talk call in
 * `lib/voiceCall/*`).
 *
 * We always ask for the browser's voice processing explicitly instead of relying on defaults (`audio: true` is
 * "whatever the browser feels like", and some media layers, e.g. the Daily call object that Pipecat's SmallWebRTC
 * transport uses by default, pick their own). Plain `true` values are *ideal* constraints in getUserMedia, so a device that
 * cannot honour one still opens (no OverconstrainedError); `track.getSettings()` then tells us what we really got.
 *
 * Browser notes (comments, not code paths):
 *  - Chrome / Edge: echoCancellation can use the OS canceller (macOS, Windows) or WebRTC's AEC3. Either way the canceller only
 *    knows what the speaker plays if that audio goes through a WebRTC-rendered `<audio>`/`<video>` element, which is why
 *    the call plays the bot through one `<audio playsinline>` bound to the remote MediaStream and never through Web Audio.
 *  - Safari / iOS: WebKit runs its own voice processing whenever the page captures and plays at once. It honours
 *    `echoCancellation`; `noiseSuppression` and `autoGainControl` are accepted but `getSettings()` may leave them
 *    undefined, so "undefined" is reported as unknown, not as a failure. When a mic is open, iPhones can also route
 *    playback to the quiet earpiece unless the media element is `playsinline`. Opening a second getUserMedia stream next
 *    to `webkitSpeechRecognition` can silence one of them, so Table Mode never does that on Safari.
 *  - Firefox: honours all three; there is no SpeechRecognition, so Table Mode records and posts to the worker instead.
 *  - Nothing here can cancel noise that the browser cannot hear as noise (a second talker, a TV). That is what
 *    hold-to-talk is for.
 */

export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
} as const satisfies MediaTrackConstraints;

/** What the browser reports it applied. `null` = the browser did not say (older Safari), which is not a failure. */
export interface MicProcessing {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  channelCount: number | null;
  /** True when every setting we asked for is confirmed on. */
  allApplied: boolean;
  deviceLabel: string;
}

export function micConstraints(deviceId?: string): MediaTrackConstraints {
  // `ideal`, not `exact`: a remembered device that was unplugged must fall back to the default mic, not fail the call.
  return deviceId ? { ...MIC_CONSTRAINTS, deviceId: { ideal: deviceId } } : { ...MIC_CONSTRAINTS };
}

function flag(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Pure: turn `track.getSettings()` into our report (also used by the unit test). */
export function processingFromSettings(s: MediaTrackSettings, label = ""): MicProcessing {
  const echoCancellation = flag(s.echoCancellation);
  const noiseSuppression = flag(s.noiseSuppression);
  const autoGainControl = flag(s.autoGainControl);
  const channelCount = typeof s.channelCount === "number" ? s.channelCount : null;
  return {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    channelCount,
    allApplied: echoCancellation === true && noiseSuppression === true && autoGainControl === true,
    deviceLabel: label,
  };
}

const IS_DEV = process.env.NODE_ENV !== "production";
const logged = new Set<string>();

/**
 * Read `track.getSettings()` and, in development only, log it once per capture path so you can see in the console whether
 * the constraints really applied. Returns the report either way.
 */
export function reportMicSettings(path: string, track: MediaStreamTrack): MicProcessing {
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings();
  } catch {
    /* ancient browser */
  }
  const report = processingFromSettings(settings, track.label);
  if (IS_DEV && !logged.has(path)) {
    logged.add(path);
    const unmet = (["echoCancellation", "noiseSuppression", "autoGainControl"] as const).filter((k) => report[k] === false);
    console.info(`[voice] mic settings (${path})`, { requested: MIC_CONSTRAINTS, applied: settings, label: track.label });
    if (unmet.length) console.warn(`[voice] the browser did not apply: ${unmet.join(", ")} (path: ${path})`);
  }
  return report;
}

/**
 * Open the microphone with the shared constraints. If the browser rejects the constraint set itself (very old Android
 * WebViews throw TypeError / OverconstrainedError for unknown keys), retry bare: a mic with defaults beats no mic.
 * Permission errors are NOT retried; they propagate untouched.
 */
export async function openMicStream(path: string, deviceId?: string): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({ audio: micConstraints(deviceId), video: false });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name !== "OverconstrainedError" && name !== "TypeError") throw e;
    stream = await md.getUserMedia({ audio: true, video: false });
  }
  const track = stream.getAudioTracks()[0];
  if (track) reportMicSettings(path, track);
  return stream;
}

/** Development-only handle used by the Playwright check (`window.__keystoneVoice`). Absent from production builds. */
export function exposeForDevTools(entries: Record<string, unknown>): void {
  if (!IS_DEV || typeof window === "undefined") return;
  const w = window as unknown as { __keystoneVoice?: Record<string, unknown> };
  w.__keystoneVoice = Object.assign(w.__keystoneVoice ?? {}, entries);
}
