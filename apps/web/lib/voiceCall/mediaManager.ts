import type { DeviceError, MediaSupport, Participant, PipecatClientOptions, RTVIEventCallbacks, Tracks } from "@pipecat-ai/client-js";
import { openMicStream, reportMicSettings, type MicProcessing } from "./audio";

/**
 * The microphone half of the Pipecat SmallWebRTC transport, with explicit audio constraints.
 *
 * Why this exists: in @pipecat-ai/small-webrtc-transport 1.11.2 the default media manager is Daily's
 * (`DailyMediaManager` -> a daily-js call object -> `startCamera()`), which has no way to pass getUserMedia constraints
 * (no `setAudioConstraints`; `updateMic()` only takes a device id), loads its capture code from Daily's CDN, and
 * re-acquires the track on every mute. The transport's public `mediaManager` option exists exactly for this: whatever we
 * pass is asked for `initialize()/connect()/disconnect()`, `tracks().local.audio`, `enableMic()`, and the device lists.
 * (The abstract `MediaManager` class lives in `@pipecat-ai/transport-lib`, which the transport bundles instead of
 * exporting, so this class mirrors the surface the transport calls rather than extending it.)
 *
 * What it does on top of "getUserMedia":
 *  - asks for { echoCancellation, noiseSuppression, autoGainControl, channelCount: 1 } and logs `track.getSettings()` in dev;
 *  - keeps ONE live track for the whole call and gates it with `track.enabled` (hold-to-talk, speakerphone guard,
 *    mute): the RTP stream keeps flowing as digital silence, so the server's VAD still sees the pause that ends a turn,
 *    and re-opening the gate is instant (no new permission prompt, no new track, no renegotiation);
 *  - tells the client about the mic (`onMicUpdated`) so `mediaState.mic` becomes "granted", and about a mic that dies
 *    mid-call (`onDeviceError`).
 */

export interface ConstrainedMicOptions {
  /** `DeviceError` lives in the lazily loaded client chunk, so the session hands us a factory instead of an import. */
  makeDeviceError: (type: "permissions" | "not-found" | "constraints" | "in-use" | "undefined-mediadevices" | "unknown", message: string, cause?: unknown) => DeviceError;
  /** Called with the new track when `updateMic()` swaps the device mid-call so the session can `replaceTrack` on the sender. */
  onTrackReplaced?: (track: MediaStreamTrack) => void;
  /** Start with the gate closed (hold-to-talk was on when the call began). */
  gateOpen?: boolean;
}

const LOCAL: Participant = { id: "local", name: "", local: true };

function errorType(e: unknown): "permissions" | "not-found" | "constraints" | "in-use" | "undefined-mediadevices" | "unknown" {
  const name = (e as { name?: string } | null)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError": return "permissions";
    case "NotFoundError": return "not-found";
    case "OverconstrainedError": return "constraints";
    case "NotReadableError":
    case "AbortError": return "in-use";
    default: return "unknown";
  }
}

export class ConstrainedMicManager {
  readonly supportsScreenShare = false;

  private options: PipecatClientOptions | null = null;
  private callbacks: RTVIEventCallbacks = {};
  private micEnabled = true; // "not muted": what client.enableMic() controls
  private gateOpen: boolean; // hold-to-talk / speakerphone guard: what the session controls
  private stream: MediaStream | null = null;
  private current: MediaStreamTrack | null = null;
  private selected: MediaDeviceInfo | Record<string, never> = {};
  private starting: Promise<void> | null = null;
  private closing = false;
  private lastDeviceId: string | undefined;

  constructor(private readonly opts: ConstrainedMicOptions) {
    this.gateOpen = opts.gateOpen ?? true;
  }

  // ------------------------------------------------------------------ what the session uses

  /** The live capture track (undefined before `initialize()` and after `disconnect()`). */
  get track(): MediaStreamTrack | undefined {
    return this.current ?? undefined;
  }

  /** The browser's own report of the processing it applied to the track. */
  get processing(): MicProcessing | null {
    return this.current ? reportMicSettings("call", this.current) : null;
  }

  /** Open or close the gate. Closed = the track is disabled and the server hears digital silence. */
  setGate(open: boolean) {
    this.gateOpen = open;
    this.applyTrack();
  }

  /** Is sound reaching the peer connection right now? */
  get live(): boolean {
    return !!this.current && this.current.readyState === "live" && this.current.enabled;
  }

  // ------------------------------------------------------------------ MediaManager surface (called by the transport)

  setUserAudioCallback() {
    /* websocket-style transports only */
  }

  setClientOptions(options: PipecatClientOptions, override = false) {
    if (this.options && !override) return;
    this.options = options;
    this.callbacks = options.callbacks ?? {};
    this.micEnabled = options.enableMic ?? true;
  }

  async initialize(): Promise<void> {
    if (this.current && this.current.readyState === "live") return;
    this.starting ??= this.capture(this.lastDeviceId).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    const t = this.current;
    this.stopStream();
    if (t) this.callbacks.onTrackStopped?.(t, LOCAL);
    this.closing = false;
  }

  async getAllMics(): Promise<MediaDeviceInfo[]> {
    return (await this.devices()).filter((d) => d.kind === "audioinput");
  }
  async getAllCams(): Promise<MediaDeviceInfo[]> {
    return [];
  }
  async getAllSpeakers(): Promise<MediaDeviceInfo[]> {
    return (await this.devices()).filter((d) => d.kind === "audiooutput");
  }

  async updateMic(micId: string): Promise<void> {
    this.lastDeviceId = micId || undefined;
    const old = this.current;
    await this.capture(this.lastDeviceId);
    if (this.current && this.current !== old) this.opts.onTrackReplaced?.(this.current);
    if (old && old !== this.current) {
      old.stop();
      this.callbacks.onTrackStopped?.(old, LOCAL);
    }
  }
  updateCam() {
    /* audio only */
  }
  updateSpeaker() {
    /* playback is one <audio> element owned by the session */
  }

  get selectedMic() {
    return this.selected;
  }
  get selectedCam() {
    return {};
  }
  get selectedSpeaker() {
    return {};
  }

  enableMic(enable: boolean) {
    this.micEnabled = enable;
    this.applyTrack();
  }
  enableCam() {
    /* audio only */
  }
  enableScreenShare() {
    /* audio only */
  }
  get isMicEnabled() {
    return this.micEnabled;
  }
  get isCamEnabled() {
    return false;
  }
  get isSharingScreen() {
    return false;
  }
  get mediaSupport(): MediaSupport {
    return { mic: true, cam: false, screenShare: false };
  }

  tracks(): Tracks {
    return { local: this.current ? { audio: this.current } : {} };
  }

  // ------------------------------------------------------------------ internals

  private applyTrack() {
    if (this.current) this.current.enabled = this.micEnabled && this.gateOpen;
  }

  private async devices(): Promise<MediaDeviceInfo[]> {
    try {
      return await navigator.mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
  }

  private stopStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.current = null;
  }

  private async capture(deviceId?: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = this.opts.makeDeviceError("undefined-mediadevices", "This browser cannot open the microphone");
      this.callbacks.onDeviceError?.(err);
      throw err;
    }
    let stream: MediaStream;
    try {
      stream = await openMicStream("call", deviceId);
    } catch (e) {
      const err = this.opts.makeDeviceError(errorType(e), (e as { message?: string } | null)?.message || String(e), e);
      this.callbacks.onDeviceError?.(err);
      throw err;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      const err = this.opts.makeDeviceError("not-found", "No microphone track was returned");
      this.callbacks.onDeviceError?.(err);
      throw err;
    }
    // Swap in the new stream. (On first capture there is nothing to stop.)
    const previous = this.stream;
    this.stream = stream;
    this.current = track;
    if (previous && previous !== stream) previous.getTracks().forEach((t) => t.stop());
    this.applyTrack();

    track.addEventListener("ended", () => {
      // Unplugged, revoked, or taken by another app. Not our own stop().
      if (this.closing || this.current !== track) return;
      this.callbacks.onDeviceError?.(this.opts.makeDeviceError("in-use", "The microphone stopped (unplugged, or another app took it)"));
    });

    const all = await this.getAllMics();
    const id = track.getSettings().deviceId || "default";
    this.selected = all.find((d) => d.deviceId === id) ?? ({ deviceId: id, kind: "audioinput", label: track.label, groupId: track.getSettings().groupId ?? "" } as MediaDeviceInfo);
    this.callbacks.onAvailableMicsUpdated?.(all);
    this.callbacks.onMicUpdated?.(this.selected as MediaDeviceInfo);
    this.callbacks.onTrackStarted?.(track, LOCAL);
  }
}
