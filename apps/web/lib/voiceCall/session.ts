"use client";
import { requestBrianCall } from "@/lib/data/actions";
import { useSyncExternalStore } from "react";
import type { BotOutputData, DeviceError, Participant, PipecatClient, RTVIEventCallbacks, RTVIMessage, TranscriptData, TransportState, UserInputData } from "@pipecat-ai/client-js";
import { PRODUCT_NAME, VOICE_URL } from "@/lib/constants";
import { checkVoice, getCallbackWeb } from "./health";
import { isNewSegment } from "./segments";
import { exposeForDevTools, type MicProcessing } from "./audio";
import { BOT_TAIL_MS, botStuckAfterMs, HOLD_FAILSAFE_MS, INTERRUPT_WINDOW_MS, micGateOpen, RELEASE_TAIL_MS } from "./gate";
import { ConstrainedMicManager } from "./mediaManager";
import { getVoicePrefs, setHalfDuplexPref, setPushToTalkPref, subscribeVoicePrefs } from "./prefs";

/**
 * The browser side of a voice call: Pipecat SmallWebRTC against `POST {VOICE_URL}/api/offer`.
 *
 * Everything lives in this module (not in a React tree) on purpose. The call has to survive navigation: the
 * "See what the agent is doing" link leaves the page the call started on, and AppShell (and the sheet) remount.
 * Components subscribe with `useCall()` and call the exported functions below.
 *
 * Phases:  idle -> (explainer) -> connecting -> live -> ended      any step can fall into `error`.
 *
 * Contract with the bot (see docs/voice-selfhost.md):
 *   - request data on the offer: { household_id, display_name }
 *   - standard RTVI events drive the captions (user-input / bot-output, or the older user-transcription /
 *     bot-transcription), and a server message { type: "run", run_id } announces the agent run for this call.
 *
 * Mobile notes: audio is unlocked inside the tap that starts the call (a muted-by-policy `<audio playsinline>` plus a
 * resumed AudioContext), and if the browser still refuses to play the bot, `soundBlocked` shows a "tap to turn sound on".
 *
 * Echo and noise (see audio.ts for the browser notes):
 *   - the microphone is opened by our own `ConstrainedMicManager` with echoCancellation / noiseSuppression /
 *     autoGainControl / channelCount 1 requested explicitly, and `track.getSettings()` is logged once in dev;
 *   - the bot plays through exactly ONE `<audio playsinline>` bound to the WebRTC remote MediaStream. Web Audio only ever
 *     *reads* that stream for the level meters (the analyser is not connected to the destination), so the browser's echo
 *     canceller still sees the playout as its reference signal;
 *   - hold-to-talk (`setPushToTalk` / `pressTalk` / `releaseTalk`) and the speakerphone guard (`setHalfDuplex`,
 *     `interrupt`) gate the mic track with `track.enabled`. State: `pushToTalk, talkHeld, halfDuplex, botSpeaking, micLive`.
 *   - client messages to the bot (server contract in docs/contracts.md section 8): `ptt` {state: enabled | disabled |
 *     pressed | released} and `interrupt`.
 */

export const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
export const SUGGESTIONS = ["How are we doing?", "What's coming up this month?", "What if we buy a $35k car?"];

const CONNECT_TIMEOUT_MS = 25_000;
const MAX_CAPTIONS = 60;

export type CallPhase = "idle" | "explainer" | "connecting" | "live" | "ended" | "error";
export type CallErrorKind =
  | "mic-blocked" | "mic-missing" | "mic-busy"
  | "offline" | "cors" | "busy" | "network" | "insecure" | "unsupported" | "lost" | "unknown";
export interface CallError {
  kind: CallErrorKind;
  /** Technical detail for the "details" disclosure; never the headline. */
  detail?: string;
}
export type Activity = "idle" | "listening" | "you" | "thinking" | "assistant";
export type MicPermission = "granted" | "denied" | "prompt" | "unknown";
export type EndReason = "user" | "bot" | "lost";

export interface Caption {
  id: number;
  role: "user" | "assistant";
  /** Final text. */
  text: string;
  /** Not-yet-final tail of what the user is saying (shown dimmed). */
  interim: string;
  /** The assistant was cut off mid-answer. */
  interrupted?: boolean;
}

export interface CallState {
  sheetOpen: boolean;
  phase: CallPhase;
  /** Human text for the connecting phase. */
  step: string;
  error: CallError | null;
  muted: boolean;
  activity: Activity;
  captions: Caption[];
  runId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
  /** The browser refused to start the bot's audio; needs a tap. */
  soundBlocked: boolean;
  /** A non-fatal problem during the call (e.g. the mic was unplugged). */
  notice: string | null;
  mic: MicPermission;
  /** A suggested prompt the person tapped, shown big so it is easy to read out. */
  hint: string | null;
  /** Hold-to-talk is on: the mic is silent except while the talk button is held. Remembered between visits. */
  pushToTalk: boolean;
  /** The talk button is down right now (hold-to-talk only). */
  talkHeld: boolean;
  /** Speakerphone guard is on: the mic goes quiet while the assistant talks. Default on for phones; remembered. */
  halfDuplex: boolean;
  /** The assistant is speaking (RTVI bot-started/stopped-speaking, plus a short tail while the speaker drains). */
  botSpeaking: boolean;
  /** Sound is really reaching the assistant: call connecting/live, not muted, not gated by hold-to-talk or the guard. */
  micLive: boolean;
  /** What the browser reports it applied to the mic (`track.getSettings()`); null until the mic is open. */
  processing: MicProcessing | null;
}

const INITIAL: CallState = {
  sheetOpen: false,
  phase: "idle",
  step: "",
  error: null,
  muted: false,
  activity: "idle",
  captions: [],
  runId: null,
  startedAt: null,
  endedAt: null,
  endReason: null,
  soundBlocked: false,
  notice: null,
  mic: "unknown",
  hint: null,
  pushToTalk: false,
  talkHeld: false,
  halfDuplex: false,
  botSpeaking: false,
  micLive: false,
  processing: null,
};

/** The per-call part of the voice-control state; reset whenever a call starts or ends. */
const CALL_CONTROLS = { talkHeld: false, botSpeaking: false, micLive: false, processing: null } as const;

let state: CallState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getCallState(): CallState {
  return state;
}
export function useCall(): CallState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}
export const isCallActive = (s: CallState = state) => s.phase === "connecting" || s.phase === "live";

// ------------------------------------------------------------------------------------------------ module state

type Libs = {
  PipecatClient: typeof import("@pipecat-ai/client-js").PipecatClient;
  DeviceError: typeof import("@pipecat-ai/client-js").DeviceError;
  SmallWebRTCTransport: typeof import("@pipecat-ai/small-webrtc-transport").SmallWebRTCTransport;
};

let libsPromise: Promise<Libs> | null = null;
let client: PipecatClient | null = null;
let attempt = 0; // bumped on every start / cleanup so late async results from an old attempt are ignored
let userHungUp = false;
let botLeft = false;
let connected = false;
let transportStarted = false;
let deviceError: { type?: string; message?: string } | null = null;
let abortConnect: ((e: unknown) => void) | null = null;
let lastArgs: StartArgs | null = null;

let micMgr: ConstrainedMicManager | null = null; // the call's microphone (null between calls)
let gateHeld = false; // the talk button is down, or inside its short release tail
let interruptOn = false; // "Interrupt" was tapped and its window is still open
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let botTailTimer: ReturnType<typeof setTimeout> | undefined;
let interruptTimer: ReturnType<typeof setTimeout> | undefined;
let holdFailsafe: ReturnType<typeof setTimeout> | undefined;

let audioEl: HTMLAudioElement | null = null;
let remoteTrack: MediaStreamTrack | null = null;
let ctx: AudioContext | null = null;
let remoteNode: { src: MediaStreamAudioSourceNode; an: AnalyserNode } | null = null;
let localNode: { src: MediaStreamAudioSourceNode; an: AnalyserNode } | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let micWatch: PermissionStatus | null = null;
let globalListeners = false;

let captionSeq = 0;
let sawUserInput = false;
let sawBotOutput = false;
const seenSegments = new Set<number | string>(); // spoken sentences already shown (the server repeats each one for every word spoken)
let sawBotSentence = false;

const flags = { userSpeaking: false, botSpeaking: false, thinking: false, thinkingAt: 0, userLoudAt: 0, botLoudAt: 0 };
const cbLevels = { user: 0, bot: 0 };
const levels = { user: 0, bot: 0 };
let pending: Activity = "idle";
let pendingTicks = 0;

/** Smoothed 0..1 mic and bot levels, read by the orb on every animation frame (not React state). */
export function getLevels(): { user: number; bot: number } {
  return levels;
}

// ------------------------------------------------------------------------------------------------ sheet + small setters

export function openCallSheet(opts?: { prompt?: string }) {
  set({ sheetOpen: true, hint: opts?.prompt ?? state.hint });
  void refreshMic();
  void checkVoice(true);
  void loadLibs().catch(() => undefined); // warm the (large) WebRTC chunk before the tap
}

export function closeCallSheet() {
  if (state.phase === "explainer" || state.phase === "ended" || state.phase === "error") {
    // Nothing to keep: drop the captions so a transcript never outlives the window that showed it.
    set({ ...INITIAL, mic: state.mic, sheetOpen: false, pushToTalk: state.pushToTalk, halfDuplex: state.halfDuplex });
    return;
  }
  set({ sheetOpen: false });
}

export function setHint(hint: string | null) {
  set({ hint });
}

/** Back to the start screen (after an error or a finished call). */
export function resetCall() {
  if (isCallActive()) return;
  set({ ...INITIAL, mic: state.mic, sheetOpen: state.sheetOpen, hint: state.hint, pushToTalk: state.pushToTalk, halfDuplex: state.halfDuplex });
}

async function refreshMic() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" as PermissionName });
    set({ mic: p.state as MicPermission });
    if (micWatch !== p) {
      if (micWatch) micWatch.onchange = null;
      micWatch = p;
      p.onchange = () => set({ mic: p.state as MicPermission });
    }
  } catch {
    // Safari before 16 and some webviews cannot answer; the explainer then shows on first use.
    set({ mic: "unknown" });
  }
}

// ------------------------------------------------------------------------------------------------ start

export interface StartArgs {
  householdId: string;
  displayName: string;
  /** Set when this call answers an incoming call from Brian: the voice service opens in callback mode about this alert ("" = he picks one). */
  callback?: { alertId: string; callId: string };
}

function envProblem(): CallErrorKind | null {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") return "unsupported";
  return null;
}

function fail(kind: CallErrorKind, detail?: string) {
  void cleanup();
  set({ phase: "error", error: { kind, detail }, step: "", activity: "idle", muted: false, ...CALL_CONTROLS });
}

/**
 * Call this straight from the tap. It unlocks audio first (this must happen in the gesture), then either shows the
 * microphone explainer (first time) or connects. `skipExplainer` is the "Allow microphone and start" button.
 */
export function startCall(args: StartArgs, opts?: { skipExplainer?: boolean }) {
  if (isCallActive()) return;
  cancelRingBack();
  lastArgs = args;
  unlockAudio();
  const problem = envProblem();
  if (problem) return fail(problem);
  // A retry always tries the browser (the Permissions API can be stale after someone fixes the setting).
  if (!opts?.skipExplainer && state.mic === "denied") return fail("mic-blocked");
  if (!opts?.skipExplainer && state.mic !== "granted") {
    set({ phase: "explainer", error: null });
    return;
  }
  void connect(args);
}

export function retryCall() {
  if (lastArgs) startCall(lastArgs, { skipExplainer: true });
}

async function connect(args: StartArgs) {
  const mine = ++attempt;
  const stale = () => mine !== attempt;
  userHungUp = false;
  botLeft = false;
  connected = false;
  transportStarted = false;
  deviceError = null;
  sawUserInput = sawBotOutput = sawBotSentence = false;
  seenSegments.clear();
  Object.assign(flags, { userSpeaking: false, botSpeaking: false, thinking: false, thinkingAt: 0, userLoudAt: 0, botLoudAt: 0 });
  cbLevels.user = cbLevels.bot = levels.user = levels.bot = 0;
  resetGateTimers();
  set({
    phase: "connecting", step: "Checking the voice line", error: null, muted: false, activity: "idle", captions: [], runId: null,
    startedAt: null, endedAt: null, endReason: null, soundBlocked: false, notice: null, ...CALL_CONTROLS,
  });
  registerGlobalListeners();

  // 1. Is anything there? Failing here is cheap and avoids a pointless microphone prompt.
  if ((await checkVoice(true)) === "down") return stale() ? undefined : fail("offline");
  if (stale()) return;

  // 2. The WebRTC client (a separate chunk).
  let libs: Libs;
  try {
    libs = await loadLibs();
  } catch (e) {
    return stale() ? undefined : fail("unknown", `Could not load the voice client: ${describe(e)}`);
  }
  if (stale()) return;

  // Our own media manager instead of the transport's default (Daily's): it is the only way to pass getUserMedia constraints in
  // these package versions. See mediaManager.ts.
  const micManager = new ConstrainedMicManager({
    makeDeviceError: (type, message, cause) => new libs.DeviceError(["mic"], type, message, cause instanceof Error ? { sourceError: cause } : undefined),
    onTrackReplaced: (track) => {
      // updateMic() mid-call: hand the new track to the sender (the transport does this itself for its default manager).
      const t = c.transport as unknown as { getAudioTransceiver?: () => RTCRtpTransceiver };
      void t.getAudioTransceiver?.().sender.replaceTrack(track).catch(() => undefined);
    },
    gateOpen: micGateOpen(gateInput()), // hold-to-talk starts closed, so nothing leaks before the first press
  });
  micMgr = micManager;
  const c = new libs.PipecatClient({
    transport: new libs.SmallWebRTCTransport({ iceServers: ICE_SERVERS, waitForICEGathering: true, mediaManager: micManager }),
    enableMic: true,
    enableCam: false,
    callbacks: callbacks(mine),
  });
  client = c;

  // 3. Microphone (this is where the browser's permission prompt appears).
  set({ step: "Waiting for your microphone" });
  try {
    await c.initDevices();
  } catch (e) {
    return stale() ? undefined : fail(...classify(e));
  }
  if (stale()) return;
  // The WebRTC client does not always throw when the browser refuses the microphone: it logs a device error, carries on
  // without an audio track, and the call would "connect" with nobody able to hear you. Check the outcome explicitly.
  const mic = c.mediaState.mic;
  if (deviceError || mic.state === "error" || mic.state === "uninitialized") {
    const [kind, detail] = micProblem(mic, deviceError);
    return fail(kind, detail);
  }
  set({ mic: "granted", processing: micManager.processing }); // some browsers cannot answer the Permissions API; a successful open is proof enough
  applyMic();
  void refreshMic();

  // 4. Offer / answer, ICE, and the bot saying it is ready.
  set({ step: `Calling ${PRODUCT_NAME}` });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      c.connect({ webrtcRequestParams: { endpoint: `${VOICE_URL}/api/offer`, requestData: { household_id: args.householdId, display_name: args.displayName, ...(args.callback ? { callback: true, alert_id: args.callback.alertId, call_id: args.callback.callId } : {}) } } }),
      new Promise<never>((_, reject) => {
        abortConnect = reject;
        timeout = setTimeout(() => reject(new ConnectTimeout(connected)), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    if (stale()) return;
    const [kind, detail] = classify(e);
    // A fetch that failed outright (no HTTP status): tell "service is down" from "service is up but blocks this site".
    if (kind === "offline" && statusOf(e) === undefined && (await checkVoice(true)) === "up") return stale() ? undefined : fail("cors", detail);
    return stale() ? undefined : fail(kind, detail);
  } finally {
    if (timeout) clearTimeout(timeout);
    abortConnect = null;
  }
  if (stale()) return;

  set({ phase: "live", step: "", startedAt: Date.now(), activity: "listening" });
  if (state.pushToTalk) tellBot("ptt", { state: "enabled" }); // the bot must know from the first second that silence between presses is expected
  startLevelTimer();
  void keepAwake();
  void playRemote();
}

class ConnectTimeout extends Error {
  constructor(readonly reachedPeer: boolean) {
    super(reachedPeer ? "The assistant did not answer in time" : "The audio connection did not come up in time");
  }
}

// ------------------------------------------------------------------------------------------------ libraries

function loadLibs(): Promise<Libs> {
  libsPromise ??= Promise.all([import("@pipecat-ai/client-js"), import("@pipecat-ai/small-webrtc-transport")])
    .then(([a, b]) => {
      // The client is chatty (a debug line per ICE candidate) and logs expected failures with console.error, which the
      // Next dev overlay turns into a full-screen error. Failures reach people through the call sheet instead.
      let debug = false;
      try {
        debug = localStorage.getItem("voice.debug") === "1";
      } catch {
        /* private mode */
      }
      a.logger.setLevel(debug ? a.LogLevel.DEBUG : a.LogLevel.NONE);
      return { PipecatClient: a.PipecatClient, DeviceError: a.DeviceError, SmallWebRTCTransport: b.SmallWebRTCTransport };
    })
    .catch((e) => {
      libsPromise = null;
      throw e;
    });
  return libsPromise;
}

// ------------------------------------------------------------------------------------------------ errors

function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "object" && e && "status" in e) return `HTTP ${(e as { status: number }).status}`;
  return String(e);
}

function micProblem(mic: { state: string; reason?: string; details?: unknown }, dev: { type?: string; message?: string } | null): [CallErrorKind, string | undefined] {
  const detail = dev?.message ?? (typeof mic.details === "string" ? mic.details : undefined) ?? mic.reason;
  const t = dev?.type;
  if (t === "permissions" || mic.reason === "blocked") return ["mic-blocked", detail];
  if (t === "in-use" || mic.reason === "already-in-use") return ["mic-busy", detail];
  if (t === "not-found" || t === "constraints" || mic.reason === "not-found" || mic.reason === "invalid-constraints") return ["mic-missing", detail];
  if (t === "undefined-mediadevices" || mic.reason === "not-supported") return [typeof window !== "undefined" && window.isSecureContext ? "unsupported" : "insecure", detail];
  // The client sometimes reports a raw browser error name instead of a category.
  if (detail && /NotReadable|AbortError|in use|in-use|busy|Could not start/i.test(detail)) return ["mic-busy", detail];
  if (detail && /NotFound|Overconstrained|not found|no .*device/i.test(detail)) return ["mic-missing", detail];
  if (detail && /NotAllowed|SecurityError|denied|permission/i.test(detail)) return ["mic-blocked", detail];
  // Not acquired and no reason given: the most common cause by far is a permission the browser would not grant.
  return [mic.state === "uninitialized" ? "mic-blocked" : "unknown", detail];
}

function statusOf(e: unknown): number | undefined {
  const o = (e ?? {}) as { status?: unknown; cause?: { status?: unknown } };
  const st = o.status ?? o.cause?.status;
  return typeof st === "number" ? st : undefined;
}

/** Map anything thrown while starting a call to one of our plain-language error kinds. */
function classify(e: unknown): [CallErrorKind, string | undefined] {
  const detail = describe(e);
  if (e instanceof ConnectTimeout) return [e.reachedPeer ? "unknown" : "network", detail];
  const o = (e ?? {}) as { name?: string; type?: string; devices?: unknown; status?: number; cause?: unknown; message?: string };

  // Pipecat's DeviceError
  if (Array.isArray(o.devices) && typeof o.type === "string") {
    switch (o.type) {
      case "permissions": return ["mic-blocked", detail];
      case "not-found":
      case "constraints": return ["mic-missing", detail];
      case "in-use": return ["mic-busy", detail];
      case "undefined-mediadevices": return [window.isSecureContext ? "unsupported" : "insecure", detail];
      default: return ["unknown", detail];
    }
  }
  // getUserMedia DOMExceptions
  switch (o.name) {
    case "NotAllowedError":
    case "SecurityError": return ["mic-blocked", detail];
    case "NotFoundError":
    case "OverconstrainedError": return ["mic-missing", detail];
    case "NotReadableError":
    case "AbortError": return ["mic-busy", detail];
  }
  // HTTP status from the offer endpoint (a Response, or an error carrying .status / .cause)
  const status = statusOf(e);
  if (typeof status === "number") {
    if (status === 429) return ["busy", `HTTP ${status}`];
    if (status === 502 || status === 503 || status === 504) return ["offline", `HTTP ${status}`];
    return ["unknown", `HTTP ${status}`];
  }
  if (o.cause instanceof TypeError || e instanceof TypeError) return ["offline", detail];
  return ["unknown", detail];
}

// ------------------------------------------------------------------------------------------------ RTVI callbacks

function callbacks(mine: number): RTVIEventCallbacks {
  const live = () => mine === attempt;
  return {
    onConnected: () => {
      if (!live()) return;
      connected = true;
      set({ step: `Waiting for ${PRODUCT_NAME} to pick up` });
    },
    onTransportStateChanged: (s: TransportState) => {
      if (!live() || state.phase !== "connecting") return;
      if (s === "connecting" || s === "connected") transportStarted = true;
      if (s === "error" || (s === "disconnected" && transportStarted)) {
        // Give connect()'s own rejection (it carries the HTTP status) a moment to win the race.
        const abort = abortConnect;
        setTimeout(() => abort?.(new Error("The audio connection failed")), 600);
      }
    },
    onError: (m: RTVIMessage) => {
      if (!live()) return;
      const d = (m?.data ?? {}) as { error?: string; message?: string; fatal?: boolean };
      const text = d.error ?? d.message ?? "The voice service reported an error";
      if (state.phase === "connecting") {
        if (d.fatal) abortConnect?.(new Error(text));
      } else if (state.phase === "live") {
        set({ notice: d.fatal ? `The call hit an error: ${text}` : text });
      }
    },
    onBotDisconnected: () => {
      if (live()) botLeft = true;
    },
    onDisconnected: () => {
      if (!live()) return;
      if (state.phase === "connecting") return; // connect() reports its own failure
      if (state.phase === "live") void endCall(userHungUp ? "user" : botLeft ? "bot" : "lost");
    },
    onDeviceError: (e: DeviceError) => {
      if (!live()) return;
      if (state.phase === "connecting") {
        deviceError = { type: e?.type, message: e?.message };
        return;
      }
      if (state.phase !== "live") return;
      if (e?.devices?.includes("mic")) set({ notice: "Your microphone stopped working. Check it is plugged in and allowed, then call again." });
    },
    onTrackStarted: (track: MediaStreamTrack, p?: Participant) => {
      if (!live() || track.kind !== "audio") return;
      if (p?.local) attachLocal(track);
      else {
        remoteTrack = track;
        attachRemote(track);
      }
    },
    onTrackStopped: (track: MediaStreamTrack, p?: Participant) => {
      if (track.kind !== "audio" || p?.local) return;
      if (remoteTrack === track) remoteTrack = null;
    },
    onLocalAudioLevel: (l: number) => {
      cbLevels.user = l;
    },
    onRemoteAudioLevel: (l: number) => {
      cbLevels.bot = l;
    },
    onUserStartedSpeaking: () => {
      flags.userSpeaking = true;
      flags.userLoudAt = Date.now();
      flags.thinking = false;
    },
    onUserStoppedSpeaking: () => {
      flags.userSpeaking = false;
      flags.thinking = true;
      flags.thinkingAt = Date.now();
      endInterrupt(); // the person has had their say: the speakerphone guard applies to the next answer again
    },
    onBotStartedSpeaking: () => {
      if (!live()) return;
      flags.botLoudAt = Date.now();
      flags.thinking = false;
      setBotSpeaking(true);
    },
    onBotStoppedSpeaking: () => {
      if (!live()) return;
      setBotSpeaking(false);
    },
    onBotLlmStarted: () => {
      flags.thinking = true;
      flags.thinkingAt = Date.now();
    },
    onBotInterrupted: () => {
      if (live()) setBotSpeaking(false);
      const caps = state.captions;
      const last = caps[caps.length - 1];
      if (last?.role === "assistant" && !last.interrupted) set({ captions: [...caps.slice(0, -1), { ...last, interrupted: true }] });
    },
    // captions ------------------------------------------------------------
    onUserInput: (d: UserInputData) => {
      sawUserInput = true;
      if (d.input_type === "backchannel") return;
      pushUser(d.text, !!d.final);
    },
    onUserTranscript: (d: TranscriptData) => {
      if (!sawUserInput) pushUser(d.text, !!d.final);
    },
    onBotOutput: (d: BotOutputData) => {
      sawBotOutput = true;
      if (d.will_be_spoken === false) return;
      const kind = d.output_type ?? d.aggregated_by ?? "sentence";
      if (kind === "sentence" || kind === "backchannel") {
        sawBotSentence = true;
        if (isNewSegment(seenSegments, d as { segment_id?: number | string })) pushBot(d.text, false);
      } else if (kind === "word" && !sawBotSentence) {
        pushBot(d.text, true); // bots that only send word-level output
      }
    },
    onBotTranscript: (d: { text: string }) => {
      if (!sawBotOutput) pushBot(d.text, false);
    },
    onServerMessage: (data: unknown) => {
      const m = data as { type?: string; run_id?: unknown; data?: { type?: string; run_id?: unknown } } | null;
      const inner = m?.type === "run" ? m : m?.data?.type === "run" ? m.data : null;
      if (inner && typeof inner.run_id === "string" && inner.run_id) set({ runId: inner.run_id });
    },
  };
}

function join(a: string, b: string, noSpace = false): string {
  if (!a) return b;
  return noSpace ? `${a}${b}` : `${a} ${b}`;
}
function trimCaptions(caps: Caption[]): Caption[] {
  return caps.length > MAX_CAPTIONS ? caps.slice(caps.length - MAX_CAPTIONS) : caps;
}

function pushUser(raw: string, final: boolean) {
  const text = raw.trim();
  if (!text) return;
  const caps = state.captions;
  const last = caps[caps.length - 1];
  if (last?.role === "user") {
    const next: Caption = final ? { ...last, text: join(last.text, text), interim: "" } : { ...last, interim: text };
    set({ captions: [...caps.slice(0, -1), next] });
  } else {
    set({ captions: trimCaptions([...caps, { id: ++captionSeq, role: "user", text: final ? text : "", interim: final ? "" : text }]) });
  }
}

function pushBot(raw: string, wordLevel: boolean) {
  const text = wordLevel ? raw : raw.trim();
  if (!text.trim()) return;
  flags.thinking = false;
  const caps = state.captions;
  const last = caps[caps.length - 1];
  if (last?.role === "assistant" && !last.interrupted) {
    set({ captions: [...caps.slice(0, -1), { ...last, text: join(last.text, text, wordLevel) }] });
  } else {
    set({ captions: trimCaptions([...caps, { id: ++captionSeq, role: "assistant", text, interim: "" }]) });
  }
}

// ------------------------------------------------------------------------------------------------ audio

const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** Must run inside the tap. Creates the one `<audio playsinline>` element and the AudioContext, and "plays" silence. */
/** Unlock audio playback from inside a tap (browsers only allow it from a gesture). Call before any await. */
export function unlockCallAudio() {
  unlockAudio();
}

function unlockAudio() {
  try {
    if (!audioEl) {
      const a = document.createElement("audio");
      a.setAttribute("playsinline", "");
      (a as unknown as { playsInline: boolean }).playsInline = true; // iOS: stay inline, never take over the screen
      a.autoplay = true;
      a.hidden = true;
      a.setAttribute("aria-hidden", "true");
      document.body.appendChild(a);
      audioEl = a;
    }
    audioEl.muted = false;
    audioEl.srcObject = null;
    audioEl.src = SILENT_WAV;
    void audioEl.play().catch(() => undefined);
  } catch {
    /* no audio element: playRemote reports soundBlocked later */
  }
  try {
    if (!ctx || ctx.state === "closed") {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) ctx = new Ctor();
    }
    void ctx?.resume().catch(() => undefined);
  } catch {
    ctx = null;
  }
}

function makeAnalyser(track: MediaStreamTrack): { src: MediaStreamAudioSourceNode; an: AnalyserNode } | null {
  if (!ctx || ctx.state === "closed") return null;
  try {
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.2;
    src.connect(an); // not connected to the destination: playback goes through the <audio> element
    return { src, an };
  } catch {
    return null;
  }
}
function dropNode(n: { src: MediaStreamAudioSourceNode; an: AnalyserNode } | null) {
  try {
    n?.src.disconnect();
    n?.an.disconnect();
  } catch {
    /* already gone */
  }
}

let playbackLogged = false;
function attachRemote(track: MediaStreamTrack) {
  if (audioEl) {
    const cur = audioEl.srcObject instanceof MediaStream ? audioEl.srcObject.getAudioTracks()[0] : undefined;
    if (cur !== track) {
      audioEl.removeAttribute("src");
      audioEl.srcObject = new MediaStream([track]);
    }
    if (process.env.NODE_ENV !== "production" && !playbackLogged) {
      playbackLogged = true;
      // One element, playsinline, fed straight from the remote stream: the browser's echo canceller uses this playout as its reference.
      console.info("[voice] playback", { audioElements: document.querySelectorAll("audio").length, playsInline: audioEl.hasAttribute("playsinline"), remoteStreamOnElement: audioEl.srcObject instanceof MediaStream, webAudioToDestination: false });
    }
  }
  dropNode(remoteNode);
  remoteNode = makeAnalyser(track);
  void playRemote();
}
function attachLocal(track: MediaStreamTrack) {
  dropNode(localNode);
  localNode = makeAnalyser(track);
}

async function playRemote() {
  if (!audioEl || !audioEl.srcObject) return;
  try {
    await audioEl.play();
    if (state.soundBlocked) set({ soundBlocked: false });
  } catch {
    if (state.phase === "live" || state.phase === "connecting") set({ soundBlocked: true });
  }
  void ctx?.resume().catch(() => undefined);
}

/** The "Tap to turn sound on" button. */
export function enableSound() {
  void ctx?.resume().catch(() => undefined);
  void playRemote();
}

const buf = new Uint8Array(512);
function rms(n: { an: AnalyserNode } | null): number {
  if (!n) return 0;
  n.an.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const d = (buf[i] - 128) / 128;
    sum += d * d;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3.4);
}

function startLevelTimer() {
  stopLevelTimer();
  pending = "listening";
  pendingTicks = 0;
  levelTimer = setInterval(tick, 60);
}
function stopLevelTimer() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  levels.user = levels.bot = 0;
}

function tick() {
  const now = Date.now();
  const rawUser = Math.max(rms(localNode), cbLevels.user);
  const rawBot = Math.max(rms(remoteNode), cbLevels.bot);
  levels.user = state.muted ? 0 : Math.max(rawUser, levels.user * 0.8);
  levels.bot = Math.max(rawBot, levels.bot * 0.8);
  if (rawBot > 0.05) flags.botLoudAt = now;
  if (rawUser > 0.14 && !state.muted) flags.userLoudAt = now;
  if (flags.thinking && now - flags.thinkingAt > 20_000) flags.thinking = false;
  // A lost bot-stopped-speaking must never leave the speakerphone guard holding the mic shut.
  if (flags.botSpeaking && now - flags.botLoudAt > botStuckAfterMs(ctx?.state === "running" && !!remoteNode)) setBotSpeaking(false, true);

  const bot = rawBot > 0.06 || (flags.botSpeaking && now - flags.botLoudAt < 1500);
  const user = !state.muted && (rawUser > 0.2 || (flags.userSpeaking && now - flags.userLoudAt < 2500));
  const want: Activity = bot ? "assistant" : user ? "you" : flags.thinking ? "thinking" : "listening";
  if (want === state.activity) {
    pendingTicks = 0;
    return;
  }
  if (want !== pending) {
    pending = want;
    pendingTicks = 0;
  }
  pendingTicks++;
  // Calm label changes: the assistant shows immediately, everything else must hold for ~120 ms.
  if (want === "assistant" || pendingTicks >= 2) {
    pendingTicks = 0;
    set({ activity: want });
  }
}

// ------------------------------------------------------------------------------------------------ mute / hang up

export function toggleMute() {
  if (!client || state.phase !== "live") return;
  const next = !state.muted;
  try {
    client.enableMic(!next);
    set({ muted: next, activity: next && state.activity === "you" ? "listening" : state.activity });
    applyMic();
  } catch {
    set({ notice: "Couldn't change the microphone. Hang up and call again." });
  }
}

// ------------------------------------------------------------------------------------------------ ring back
// About 15 s after a real call ends, Brian "rings back" in the app with a critical alert (the app's version of the phone callback,
// docs/contracts.md section 13). Not after a call that itself answered a ring, and not after a call that barely started.
const RING_BACK_MS = 15_000;
let ringBackTimer: ReturnType<typeof setTimeout> | undefined;

function cancelRingBack() {
  clearTimeout(ringBackTimer);
  ringBackTimer = undefined;
}

function scheduleRingBack() {
  cancelRingBack();
  const args = lastArgs;
  if (!args || args.callback || !getCallbackWeb() || !state.startedAt || Date.now() - state.startedAt < 8000) return;
  ringBackTimer = setTimeout(() => void requestBrianCall(args.householdId, "", "", "callback").catch(() => undefined), RING_BACK_MS);
}

export function hangUp() {
  if (!isCallActive()) return;
  userHungUp = true;
  if (state.phase === "connecting") {
    attempt++;
    void cleanup();
    set({ phase: "idle", step: "", error: null, activity: "idle", ...CALL_CONTROLS });
    return;
  }
  void endCall("user");
}

async function endCall(reason: EndReason) {
  if (state.phase !== "live") return;
  const mine = attempt;
  set({ phase: "ended", endReason: reason, endedAt: Date.now(), activity: "idle", muted: false, soundBlocked: false, ...CALL_CONTROLS });
  scheduleRingBack();
  await cleanup(mine);
}

async function cleanup(only?: number) {
  const c = client;
  if (only !== undefined && only !== attempt) return;
  client = null;
  const micManager = micMgr;
  micMgr = null;
  resetGateTimers();
  set({ ...CALL_CONTROLS });
  stopLevelTimer();
  dropNode(remoteNode);
  dropNode(localNode);
  remoteNode = localNode = null;
  remoteTrack = null;
  abortConnect = null;
  try {
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
    }
  } catch {
    /* ignore */
  }
  try {
    const old = ctx;
    ctx = null;
    await old?.close();
  } catch {
    /* ignore */
  }
  void releaseWake();
  try {
    await c?.disconnect();
  } catch {
    /* already disconnected */
  }
  void micManager?.disconnect(); // idempotent; makes sure the mic is released even if the transport never got that far
}

// ------------------------------------------------------------------------------------------------ hold-to-talk + speakerphone guard

function gateInput() {
  return {
    muted: state.muted,
    pushToTalk: state.pushToTalk,
    held: gateHeld,
    halfDuplex: state.halfDuplex,
    botSpeaking: state.botSpeaking,
    interrupted: interruptOn,
  };
}

/**
 * The one place that decides whether sound may reach the assistant: Mute, hold-to-talk and the speakerphone guard all feed
 * `micGateOpen`, and the result is applied to the mic track (`track.enabled`). Call it after changing any of them.
 */
function applyMic() {
  const open = micGateOpen(gateInput());
  micMgr?.setGate(open);
  const live = isCallActive() && !!micMgr?.track && open;
  if (live !== state.micLive) set({ micLive: live });
}

function resetGateTimers() {
  clearTimeout(releaseTimer);
  clearTimeout(botTailTimer);
  clearTimeout(interruptTimer);
  clearTimeout(holdFailsafe);
  releaseTimer = botTailTimer = interruptTimer = holdFailsafe = undefined;
  gateHeld = false;
  interruptOn = false;
  flags.botSpeaking = false;
}

/** Tell the voice agent about a hold-to-talk / interrupt moment (contract: docs/contracts.md section 8). Never throws. */
function tellBot(type: "ptt" | "interrupt", data?: { state: "enabled" | "disabled" | "pressed" | "released" }) {
  try {
    if (client?.connected) client.sendClientMessage(type, data);
  } catch {
    /* data channel closed under us: the call is ending anyway */
  }
}

/**
 * The bot started or stopped talking. Starting closes the mic at once (half-duplex); stopping waits `BOT_TAIL_MS`, because
 * the server says "stopped" when it has sent the last audio, and the speaker is still playing the last few hundred ms.
 */
function setBotSpeaking(speaking: boolean, now = false) {
  flags.botSpeaking = speaking;
  clearTimeout(botTailTimer);
  botTailTimer = undefined;
  if (speaking) {
    if (!state.botSpeaking) set({ botSpeaking: true });
    applyMic();
    return;
  }
  const done = () => {
    botTailTimer = undefined;
    if (flags.botSpeaking) return; // it started again during the tail
    if (state.botSpeaking) set({ botSpeaking: false });
    applyMic();
  };
  if (now) done();
  else botTailTimer = setTimeout(done, BOT_TAIL_MS);
}

function endInterrupt() {
  clearTimeout(interruptTimer);
  interruptTimer = undefined;
  if (!interruptOn) return;
  interruptOn = false;
  applyMic();
}

/** Hold-to-talk: on = the mic is silent except while the talk button is held. Remembered in localStorage. */
export function setPushToTalk(enabled: boolean) {
  setPushToTalkPref(enabled); // persists, then onPrefsChanged() below does the work (also for other tabs)
}

/** Speakerphone guard: on = the mic goes quiet while the assistant talks. Remembered in localStorage. */
export function setHalfDuplex(enabled: boolean) {
  setHalfDuplexPref(enabled);
}

/** Talk button down. Bind to pointerdown (see `holdToTalkProps` in ./hold). Does nothing unless hold-to-talk is on and a call is active. */
export function pressTalk() {
  if (!state.pushToTalk || !isCallActive()) return;
  clearTimeout(releaseTimer);
  releaseTimer = undefined;
  clearTimeout(holdFailsafe);
  holdFailsafe = setTimeout(releaseTalk, HOLD_FAILSAFE_MS);
  const wasOpen = gateHeld;
  gateHeld = true;
  if (!state.talkHeld) set({ talkHeld: true });
  applyMic();
  // Pressing while the assistant talks is a deliberate barge-in; the server may treat "pressed" as one.
  if (!wasOpen) tellBot("ptt", { state: "pressed" });
}

/**
 * Talk button up. The mic stays open for `RELEASE_TAIL_MS` so the last syllable is not clipped, then closes and the bot is
 * told the person finished speaking (`ptt` / `released`), so it can answer now instead of waiting for silence detection.
 */
export function releaseTalk() {
  if (!state.talkHeld) return;
  clearTimeout(holdFailsafe);
  holdFailsafe = undefined;
  set({ talkHeld: false });
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = undefined;
    gateHeld = false;
    applyMic();
    tellBot("ptt", { state: "released" });
  }, RELEASE_TAIL_MS);
}

/**
 * "Interrupt" (shown while the assistant talks on a phone): turn the mic back on right now so the person can talk over the
 * speakerphone guard. It stays live until they finish a turn, or for `INTERRUPT_WINDOW_MS`. Also sends `interrupt` to the
 * bot, which may stop talking at once (best effort; a bot that does not know the message just hears the person next).
 */
export function interrupt() {
  if (state.phase !== "live") return;
  interruptOn = true;
  clearTimeout(interruptTimer);
  interruptTimer = setTimeout(endInterrupt, INTERRUPT_WINDOW_MS);
  applyMic();
  tellBot("interrupt");
}

/** Preferences changed (this tab, another tab, or first load). */
function onPrefsChanged() {
  const p = getVoicePrefs();
  const pttChanged = p.pushToTalk !== state.pushToTalk;
  if (pttChanged && !p.pushToTalk) {
    // Leaving hold-to-talk while the button is down: let go.
    clearTimeout(releaseTimer);
    clearTimeout(holdFailsafe);
    releaseTimer = holdFailsafe = undefined;
    gateHeld = false;
  }
  set({ pushToTalk: p.pushToTalk, halfDuplex: p.halfDuplex, ...(pttChanged && !p.pushToTalk ? { talkHeld: false } : null) });
  applyMic();
  if (pttChanged) tellBot("ptt", { state: p.pushToTalk ? "enabled" : "disabled" });
}

if (typeof window !== "undefined") {
  const p = getVoicePrefs();
  state = { ...state, pushToTalk: p.pushToTalk, halfDuplex: p.halfDuplex };
  subscribeVoicePrefs(onPrefsChanged);
  exposeForDevTools({ call: { getCallState, setPushToTalk, setHalfDuplex, pressTalk, releaseTalk, interrupt, toggleMute, startCall, hangUp } });
}

// ------------------------------------------------------------------------------------------------ page lifecycle

async function keepAwake() {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (wl && !wakeLock) wakeLock = await wl.request("screen");
  } catch {
    /* not allowed (low battery, background tab): the call still works */
  }
}
async function releaseWake() {
  try {
    await wakeLock?.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

function registerGlobalListeners() {
  if (globalListeners || typeof window === "undefined") return;
  globalListeners = true;
  // Closing the tab or leaving the site must free the microphone and tell the bot.
  window.addEventListener("pagehide", () => {
    if (!client) return;
    userHungUp = true;
    void client.disconnect().catch(() => undefined);
  });
  // iOS suspends audio when the page is backgrounded; bring it back on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") releaseTalk(); // never leave the mic open behind a backgrounded tab
    if (document.visibilityState !== "visible" || state.phase !== "live") return;
    void ctx?.resume().catch(() => undefined);
    void playRemote();
    void keepAwake();
  });
}
