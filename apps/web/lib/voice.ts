"use client";
import { useSyncExternalStore } from "react";
import { WORKER_URL } from "@/lib/constants";
import { exposeForDevTools, openMicStream, reportMicSettings, type MicProcessing } from "@/lib/voiceCall/audio";
import { RELEASE_TAIL_MS } from "@/lib/voiceCall/gate";
import { getVoicePrefs, setPushToTalkPref, subscribeVoicePrefs } from "@/lib/voiceCall/prefs";

/**
 * Table Mode voice capture.
 *
 * Primary path: the browser's Web Speech API. Every FINAL phrase goes to `onFinal` (the caller turns it into
 * `append_transcript`, so every phone in the room sees it live).
 *
 * Optional path: NVIDIA ASR via the worker (`POST {WORKER_URL}/asr?huddle_id=&speaker=`). If the worker answers
 * /health we also record the mic in short standalone segments and post them. Until the first segment is accepted,
 * browser phrases are buffered; if ASR works they are dropped (the worker appends its own transcript lines, so we
 * avoid duplicates), if it fails or returns 503 they are flushed and browser speech carries on. Any ASR failure
 * simply means "use browser speech".
 *
 * Echo and noise:
 *  - Every mic we open ourselves (the MediaRecorder path) is requested with echoCancellation / noiseSuppression /
 *    autoGainControl / channelCount 1 (see lib/voiceCall/audio.ts) and `track.getSettings()` is logged once in dev.
 *  - The Web Speech API opens its own capture and takes no constraints. Chromium-based browsers (Chrome, Edge) can be
 *    handed our processed track with `recognition.start(track)`, so on those we open one constrained stream and give it to
 *    both the recognizer and the recorder. Everywhere else (Safari, Firefox) we do NOT open a second stream next to the
 *    recognizer: on iOS two captures can silence each other, and Safari already runs its own voice processing.
 *
 * Hold-to-talk ("Noisy room? Hold to talk"): with `pushToTalk` on, nothing is listened to except while the talk button is
 * held. Pressing resumes recognition (and the recorder), releasing keeps the mic open for RELEASE_TAIL_MS and then stops
 * recognition gracefully, which makes the recognizer flush what it heard as a final phrase. The preference is remembered in
 * localStorage and shared with the Talk call.
 *
 * UI binding: `useTableVoice()` (state + actions bound to whichever capture is running) and `holdToTalkProps()` from
 * lib/voiceCall/hold.ts.
 */

interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike { isFinal: boolean; length: number; [i: number]: SpeechRecognitionAlternativeLike }
interface SpeechRecognitionEventLike { resultIndex: number; results: { length: number; [i: number]: SpeechRecognitionResultLike } }
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  /** The optional track argument is the Web Speech spec's `start(MediaStreamTrack)`; browsers without it ignore the argument. */
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Chromium-based browsers (Chrome, Edge, Brave, Opera): the ones whose recognizer accepts `start(track)`. Safari and Firefox have no userAgentData brands. */
function isChromium(): boolean {
  const brands = (navigator as unknown as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return !!brands?.some((b) => b.brand === "Chromium");
}

export function voiceSupport(): { speech: boolean; recorder: boolean; secure: boolean } {
  if (typeof window === "undefined") return { speech: false, recorder: false, secure: false };
  return {
    speech: !!speechCtor(),
    recorder: typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
    secure: window.isSecureContext,
  };
}

export interface CaptureHandlers {
  onFinal(text: string): void;
  onInterim(text: string): void;
  onError(message: string): void;
  onMode?(mode: "browser" | "nvidia-asr"): void;
}

/** What the UI binds to (see `useTableVoice`). */
export interface TableVoiceState {
  /** A capture is running (Start was tapped and Stop has not been). */
  running: boolean;
  /** Hold-to-talk is on. Remembered; readable before any capture exists. */
  pushToTalk: boolean;
  /** The talk button is down right now. */
  held: boolean;
  /** The mic is actually being listened to right now (running, and not paused by hold-to-talk). */
  micLive: boolean;
  /** What the browser reports it applied to our own mic stream; null when the browser's recognizer owns the mic. */
  processing: MicProcessing | null;
}

const SEGMENT_MS = 5000;

export class VoiceCapture {
  private rec: SpeechRecognitionLike | null = null;
  private running = false;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private segTimer: ReturnType<typeof setTimeout> | null = null;
  private asr: "off" | "unknown" | "ok" | "down" = "off";
  private buffer: string[] = [];

  // hold-to-talk
  private down = false; // button is down
  private open = false; // button is down, or inside its release tail
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private recActive = false; // SpeechRecognition between start() and end
  private trackInput: boolean | null = null; // recognizer is reading our processed track (null = not decided yet)
  private processing: MicProcessing | null = null;
  private unsubPrefs: (() => void) | null = null;

  constructor(private h: CaptureHandlers, private ctx: { huddleId: string; speaker: string }) {}

  async start(): Promise<void> {
    const sup = voiceSupport();
    if (!sup.secure) return this.h.onError("The microphone needs HTTPS. Use the text box or play a sample conversation instead.");
    if (!sup.speech && !sup.recorder) return this.h.onError("This browser can't capture voice. Use the text box or play a sample conversation.");
    this.running = true;
    setActive(this);
    this.unsubPrefs = subscribeVoicePrefs(() => this.sync());

    const workerOk = sup.recorder && (await this.workerUp());
    if (!this.running) return; // Stop was tapped while we were probing the worker
    const wantStream = workerOk || (sup.recorder && sup.speech && isChromium());
    if (workerOk) this.asr = "unknown";
    if (wantStream) {
      try {
        await this.openStream();
        if (!this.running) return this.releaseStream();
      } catch {
        if (workerOk) this.asr = "off";
      }
    }
    if (sup.speech) this.startSpeech();
    else if (this.asr === "off") {
      this.running = false;
      publish();
      this.h.onError("Live captions aren't supported in this browser. Use the text box or play a sample conversation.");
      return;
    }
    this.sync();
    this.h.onMode?.(this.asr === "off" ? "browser" : "nvidia-asr");
  }

  stop(): void {
    this.running = false;
    this.down = this.open = false;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.unsubPrefs?.();
    this.unsubPrefs = null;
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
    this.rec = null;
    this.recActive = false;
    if (this.segTimer) clearTimeout(this.segTimer);
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop(); // flushes the last segment
    } catch {
      /* ignore */
    }
    // Release the mic once the final segment has been handed off.
    const stream = this.stream;
    this.stream = null;
    this.processing = null;
    setTimeout(() => stream?.getTracks().forEach((t) => t.stop()), 300);
    if (active === this) setActive(null);
    publish();
    this.h.onInterim("");
  }

  // ---------------------------------------------------------------- hold-to-talk

  /** Turn hold-to-talk on or off (remembered). On: listening pauses until `pressTalk()`. Off: it resumes. */
  setPushToTalk(on: boolean): void {
    setPushToTalkPref(on); // persists and notifies; our prefs subscription calls sync()
  }

  /** Talk button down: resume recognition (and the recorder). No-op unless hold-to-talk is on and a capture is running. */
  pressTalk(): void {
    if (!this.running || !getVoicePrefs().pushToTalk) return;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.down = this.open = true;
    this.sync();
  }

  /** Talk button up: after a short tail, stop recognition gracefully so what was heard is delivered as a final phrase. */
  releaseTalk(): void {
    if (!this.down) return;
    this.down = false;
    publish();
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.open = false;
      this.sync();
    }, RELEASE_TAIL_MS);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isHeld(): boolean {
    return this.down;
  }

  /** The mic is being listened to right now. */
  get micLive(): boolean {
    return this.wantListening();
  }

  get micProcessing(): MicProcessing | null {
    return this.processing;
  }

  private wantListening(): boolean {
    return this.running && (!getVoicePrefs().pushToTalk || this.open);
  }

  /** Make recognition, the recorder and our track agree with `wantListening()`. Safe to call any time. */
  private sync(): void {
    if (!this.running) return;
    if (!getVoicePrefs().pushToTalk) this.down = this.open = false; // turned off while the button was down
    const want = this.wantListening();
    const track = this.stream?.getAudioTracks()[0];
    if (track) track.enabled = want;
    if (want) {
      this.resumeRecorder();
      this.beginRecognition();
    } else {
      this.pauseRecorder();
      this.endRecognition();
    }
    publish();
  }

  // ---------------------------------------------------------------- our own constrained mic

  private async openStream(): Promise<void> {
    this.stream = await openMicStream("table-mode");
    const track = this.stream.getAudioTracks()[0];
    if (track) this.processing = reportMicSettings("table-mode", track);
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  // ---------------------------------------------------------------- browser speech

  private startSpeech(): void {
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript?.trim() ?? "";
        if (!t) continue;
        if (r.isFinal) this.final(t);
        else interim += `${t} `;
      }
      this.h.onInterim(interim.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "audio-capture" && this.trackInput === true) {
        this.trackInput = false; // this browser did not like being handed our track: use its own capture (onend restarts)
        return;
      }
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.running = false;
        publish();
        this.h.onError("Microphone permission was blocked. Allow it in your browser, or use the text box.");
      } else if (e.error === "network") {
        this.h.onError("The browser's speech service is unreachable. Use the text box or a sample conversation.");
      } else if (e.error === "audio-capture") {
        this.h.onError("No microphone found. Use the text box or a sample conversation.");
      }
    };
    rec.onend = () => {
      this.recActive = false;
      // Chrome ends the session after a few seconds of silence; keep listening while the user hasn't stopped
      // (and, in hold-to-talk, only while the button is held).
      if (!this.running) return;
      if (this.wantListening()) this.beginRecognition();
      else this.h.onInterim("");
    };
    this.rec = rec;
  }

  private beginRecognition(): void {
    const rec = this.rec;
    if (!rec || this.recActive) return; // a recognizer that is still stopping restarts itself from onend
    const track = this.trackInput === false ? undefined : this.stream?.getAudioTracks()[0];
    try {
      if (track) {
        rec.start(track); // Chromium: recognize from our echo-cancelled, noise-suppressed track
        this.trackInput = true;
      } else {
        rec.start();
      }
      this.recActive = true;
    } catch (e) {
      if ((e as { name?: string } | null)?.name === "InvalidStateError") {
        this.recActive = true; // already running
      } else if (track) {
        this.trackInput = false;
        this.beginRecognition();
      } else {
        this.h.onError("Couldn't start the microphone. Use the text box instead.");
      }
    }
  }

  private endRecognition(): void {
    if (!this.rec || !this.recActive) return;
    try {
      this.rec.stop(); // graceful: pending audio is recognized and delivered, then onend
    } catch {
      /* already stopped */
    }
  }

  private final(text: string): void {
    if (this.asr === "ok") return; // the worker is transcribing this audio itself
    if (this.asr === "unknown") this.buffer.push(text);
    else this.h.onFinal(text);
  }

  // ---------------------------------------------------------------- optional NVIDIA ASR

  private async workerUp(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1200);
      const res = await fetch(`${WORKER_URL}/health`, { signal: ctl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  private resumeRecorder(): void {
    if (this.asr === "off" || this.asr === "down" || !this.stream) return;
    if (this.recorder && this.recorder.state !== "inactive") return;
    this.recordSegment();
  }

  private pauseRecorder(): void {
    if (this.segTimer) clearTimeout(this.segTimer);
    this.segTimer = null;
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop(); // flushes what was said so far
    } catch {
      /* ignore */
    }
  }

  private recordSegment(): void {
    if (!this.running || !this.stream || this.asr === "down" || this.asr === "off" || !this.wantListening()) return;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size > 800) void this.sendSegment(blob);
      if (this.running && this.recorder === rec) this.recordSegment();
    };
    this.recorder = rec;
    rec.start();
    this.segTimer = setTimeout(() => rec.state !== "inactive" && rec.stop(), SEGMENT_MS);
  }

  private async sendSegment(blob: Blob): Promise<void> {
    try {
      const q = new URLSearchParams({ huddle_id: this.ctx.huddleId, speaker: this.ctx.speaker });
      const res = await fetch(`${WORKER_URL}/asr?${q}`, { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
      if (!res.ok) throw new Error(String(res.status));
      if (this.asr === "unknown") {
        this.asr = "ok";
        this.buffer = [];
        this.h.onMode?.("nvidia-asr");
      }
    } catch {
      if (this.asr !== "down") {
        const wasUnknown = this.asr === "unknown";
        this.asr = "down";
        this.recorder = null;
        if (wasUnknown) for (const t of this.buffer) this.h.onFinal(t);
        this.buffer = [];
        this.h.onMode?.("browser");
      }
    }
  }
}

// -------------------------------------------------------------------------------------------- UI binding

let active: VoiceCapture | null = null;
function setActive(c: VoiceCapture | null) {
  active = c;
}

const IDLE: TableVoiceState = { running: false, pushToTalk: false, held: false, micLive: false, processing: null };
let snapshot: TableVoiceState = IDLE;
const listeners = new Set<() => void>();
let prefsHooked = false;

function compute(): TableVoiceState {
  return {
    running: active?.isRunning ?? false,
    pushToTalk: getVoicePrefs().pushToTalk,
    held: active?.isHeld ?? false,
    micLive: active?.micLive ?? false,
    processing: active?.micProcessing ?? null,
  };
}

function publish() {
  const next = compute();
  const prev = snapshot;
  if (next.running === prev.running && next.pushToTalk === prev.pushToTalk && next.held === prev.held && next.micLive === prev.micLive && next.processing === prev.processing) return;
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!prefsHooked) {
    prefsHooked = true;
    subscribeVoicePrefs(publish); // the toggle is usable (and its value shown) before any capture exists
  }
  publish();
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Table Mode voice controls, bound to the running capture (or to the remembered preference when none is running):
 *
 *   const v = useTableVoice();                       // { running, pushToTalk, held, micLive, processing }
 *   setTablePushToTalk(true)                          // "Noisy room? Hold to talk" toggle
 *   <button {...holdToTalkProps(pressTablePushToTalk, releaseTablePushToTalk)}>Hold to talk</button>
 */
export function useTableVoice(): TableVoiceState {
  return useSyncExternalStore(subscribe, () => snapshot, () => IDLE);
}

export function setTablePushToTalk(on: boolean): void {
  setPushToTalkPref(on);
}
export function pressTablePushToTalk(): void {
  active?.pressTalk();
}
export function releaseTablePushToTalk(): void {
  active?.releaseTalk();
}

exposeForDevTools({ table: { VoiceCapture, setTablePushToTalk, pressTablePushToTalk, releaseTablePushToTalk, getTableVoice: () => snapshot } });
