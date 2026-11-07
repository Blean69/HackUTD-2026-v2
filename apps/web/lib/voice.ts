"use client";
import { WORKER_URL } from "@/lib/constants";

/**
 * Huddle voice capture.
 *
 * Primary path: the browser's Web Speech API. Every FINAL phrase goes to `onFinal` (the caller turns it into
 * `append_transcript`, so every phone in the room sees it live).
 *
 * Optional path: NVIDIA ASR via the worker (`POST {WORKER_URL}/asr?huddle_id=&speaker=`). If the worker answers
 * /health we also record the mic in short standalone segments and post them. Until the first segment is accepted,
 * browser phrases are buffered; if ASR works they are dropped (the worker appends its own transcript lines, so we
 * avoid duplicates), if it fails or returns 503 they are flushed and browser speech carries on. Any ASR failure
 * simply means "use browser speech".
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
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
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

const SEGMENT_MS = 5000;

export class VoiceCapture {
  private rec: SpeechRecognitionLike | null = null;
  private running = false;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private segTimer: ReturnType<typeof setTimeout> | null = null;
  private asr: "off" | "unknown" | "ok" | "down" = "off";
  private buffer: string[] = [];

  constructor(private h: CaptureHandlers, private ctx: { huddleId: string; speaker: string }) {}

  async start(): Promise<void> {
    const sup = voiceSupport();
    if (!sup.secure) return this.h.onError("The microphone needs HTTPS. Use the text box or play a sample Huddle instead.");
    if (!sup.speech && !sup.recorder) return this.h.onError("This browser can't capture voice. Use the text box or play a sample Huddle.");
    this.running = true;

    if (sup.recorder && (await this.workerUp())) {
      this.asr = "unknown";
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.recordSegment();
      } catch {
        this.asr = "off";
      }
    }
    if (sup.speech) this.startSpeech();
    else if (this.asr === "off") {
      this.running = false;
      this.h.onError("Live captions aren't supported in this browser. Use the text box or play a sample Huddle.");
      return;
    }
    this.h.onMode?.(this.asr === "off" ? "browser" : "nvidia-asr");
  }

  stop(): void {
    this.running = false;
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
    this.rec = null;
    if (this.segTimer) clearTimeout(this.segTimer);
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop(); // flushes the last segment
    } catch {
      /* ignore */
    }
    // Release the mic once the final segment has been handed off.
    setTimeout(() => this.stream?.getTracks().forEach((t) => t.stop()), 300);
    this.h.onInterim("");
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
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.running = false;
        this.h.onError("Microphone permission was blocked. Allow it in your browser, or use the text box.");
      } else if (e.error === "network") {
        this.h.onError("The browser's speech service is unreachable. Use the text box or a sample Huddle.");
      } else if (e.error === "audio-capture") {
        this.h.onError("No microphone found. Use the text box or a sample Huddle.");
      }
    };
    rec.onend = () => {
      // Chrome ends the session after a few seconds of silence; keep listening while the user hasn't stopped.
      if (!this.running) return;
      try {
        rec.start();
      } catch {
        /* already started */
      }
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.h.onError("Couldn't start the microphone. Use the text box instead.");
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

  private recordSegment(): void {
    if (!this.running || !this.stream || this.asr === "down" || this.asr === "off") return;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size > 800) void this.sendSegment(blob);
      if (this.running) this.recordSegment();
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
