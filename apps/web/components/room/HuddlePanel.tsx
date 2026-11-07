"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconMic, IconPlay, IconSend, IconStop, IconShield } from "@/components/icons";
import { TraceTimeline } from "@/components/trace/TraceTimeline";
import { Avatar, Button, Card, Chip, SectionTitle } from "@/components/ui";
import { appendTranscript, endHuddle, startHuddle } from "@/lib/data/actions";
import { useConversations, useHuddle, useLatestRun, usePresence, useTraceEvents, useTranscript } from "@/lib/data/hooks";
import { cx } from "@/lib/format";
import { openTrace } from "@/lib/traceUi";
import { VoiceCapture, voiceSupport } from "@/lib/voice";
import type { Conversation } from "@/lib/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function HuddlePanel({ householdId, me }: { householdId: string; me: string }) {
  const huddle = useHuddle(householdId);
  const lines = useTranscript(huddle?.id);
  const conversations = useConversations(householdId);
  const people = usePresence(householdId);
  const run = useLatestRun(householdId, "huddle");
  const events = useTraceEvents(run?.run_id);

  const [capturing, setCapturing] = useState(false);
  const [interim, setInterim] = useState("");
  const [secs, setSecs] = useState(0);
  const [mode, setMode] = useState<"browser" | "nvidia-asr">("browser");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [text, setText] = useState("");
  const capRef = useRef<VoiceCapture | null>(null);
  const abortRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  const live = huddle?.status === "live";
  const analyzing = huddle?.status === "analyzing";
  const busyAny = busy || !!playing;

  // Stop everything if the user leaves the room mid-Huddle.
  useEffect(() => {
    const ctl = abortRef;
    return () => {
      ctl.current = true;
      capRef.current?.stop();
    };
  }, []);

  // Recording timer.
  useEffect(() => {
    if (!capturing) return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [capturing]);

  // Keep the newest line in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines.length, interim]);

  const sup = useMemo(() => (typeof window === "undefined" ? { speech: true, recorder: true, secure: true } : voiceSupport()), []);

  async function ensureHuddle(consent: string[]): Promise<string> {
    if (huddle?.status === "live") return huddle.id;
    return startHuddle(householdId, consent);
  }

  async function toggleMic() {
    setError(null);
    if (capturing) {
      capRef.current?.stop();
      capRef.current = null;
      setCapturing(false);
      return;
    }
    setBusy(true);
    try {
      const id = await ensureHuddle([me]);
      setSecs(0);
      const cap = new VoiceCapture(
        {
          onFinal: (t) => void appendTranscript(id, me, t).catch(() => undefined),
          onInterim: setInterim,
          onError: (m) => {
            setError(m);
            setCapturing(false);
            capRef.current?.stop();
            capRef.current = null;
          },
          onMode: setMode,
        },
        { huddleId: id, speaker: me },
      );
      capRef.current = cap;
      setCapturing(true);
      await cap.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the Huddle");
      setCapturing(false);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!huddle) return;
    capRef.current?.stop();
    capRef.current = null;
    setCapturing(false);
    setBusy(true);
    try {
      await endHuddle(huddle.id);
      openTrace();
    } finally {
      setBusy(false);
    }
  }

  async function playSample(c: Conversation) {
    setError(null);
    abortRef.current = false;
    setPlaying(c.id);
    try {
      const id = await ensureHuddle([`${me} (sample: ${c.title})`]);
      for (const turn of c.turns) {
        if (abortRef.current) break;
        await sleep(Math.min(2300, Math.max(900, turn.text.length * 17)));
        if (abortRef.current) break;
        await appendTranscript(id, turn.speaker, turn.text);
      }
      if (!abortRef.current) {
        await sleep(700);
        await endHuddle(id);
        openTrace();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sample failed");
    } finally {
      setPlaying(null);
    }
  }

  async function submitText() {
    const raw = text.trim();
    if (!raw) return;
    setError(null);
    setBusy(true);
    try {
      const id = await ensureHuddle([me]);
      for (const row of raw.split(/\n+/)) {
        const m = row.match(/^([A-Za-zÀ-ÿ][\w .'’-]{0,24}):\s*(.+)$/);
        await appendTranscript(id, m ? m[1].trim() : me, (m ? m[2] : row).trim());
      }
      setText("");
      await endHuddle(id);
      openTrace();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that");
    } finally {
      setBusy(false);
    }
  }

  const status = capturing ? { tone: "risk" as const, text: "Recording on this phone" } : live ? { tone: "risk" as const, text: "Huddle live" } : analyzing ? { tone: "brand" as const, text: "Agents analyzing" } : huddle?.status === "done" ? { tone: "good" as const, text: "Analysis done" } : { tone: "neutral" as const, text: "Not started" };

  return (
    <section aria-labelledby="huddle-h" className="space-y-3">
      <SectionTitle id="huddle-h" title="Huddle" sub="Talk it out together. Agents turn the conversation into goals." right={<Chip tone={status.tone}>{(capturing || live) ? <span className="anim-blink h-1.5 w-1.5 rounded-full bg-rec" aria-hidden="true" /> : null}{status.text}</Chip>} />
      <Card className="p-4">
        <p className="flex items-start gap-2 text-[0.8rem] leading-snug text-ink-2">
          <IconShield size={16} className="mt-0.5 shrink-0 text-brand" />
          <span>
            Opt-in only: nothing is heard until someone taps the mic, and only the people listed here are recorded
            {huddle?.consent_names.length ? <> (<span className="font-medium text-ink">{huddle.consent_names.join(", ")}</span>)</> : null}.
            The transcript is deleted once goals are extracted.
          </span>
        </p>

        {/* Recording banner: visible to EVERY phone in the room while a Huddle is live. */}
        {live ? (
          <div role="status" className="mt-3 flex items-center gap-2 rounded-xl bg-risk-soft px-3 py-2 text-[0.84rem] font-medium text-risk">
            <span className="anim-blink h-2.5 w-2.5 rounded-full bg-rec" aria-hidden="true" />
            Live Huddle started by {huddle.started_by_name}. Everyone in the room sees this transcript.
          </div>
        ) : null}

        <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-5">
          <button
            type="button"
            onClick={toggleMic}
            disabled={busy || !!playing || analyzing}
            aria-pressed={capturing}
            aria-label={capturing ? "Stop recording" : live ? "Add my microphone to the Huddle" : "Start a Huddle with my microphone"}
            className={cx(
              "relative flex h-24 w-24 shrink-0 items-center justify-center rounded-full text-white shadow-card transition-transform active:scale-95 disabled:opacity-50",
              capturing ? "anim-rec bg-rec" : "bg-brand text-brand-ink",
            )}
          >
            {capturing ? <IconStop size={34} /> : <IconMic size={38} />}
          </button>
          <div className="min-w-0 flex-1 text-center sm:text-left">
            {capturing ? (
              <>
                <p className="flex items-center justify-center gap-2 text-base font-semibold text-rec sm:justify-start">
                  <span className="anim-blink h-2.5 w-2.5 rounded-full bg-rec" aria-hidden="true" /> Recording · <span className="num font-mono">{mmss(secs)}</span>
                </p>
                <p className="text-[0.82rem] text-ink-2">Tap to stop. {mode === "nvidia-asr" ? "Transcribed by NVIDIA ASR." : "Live captions from your browser."}</p>
              </>
            ) : (
              <>
                <p className="text-base font-semibold">{live ? "Add my mic to this Huddle" : analyzing ? "Agents are working…" : "Tap to start a Huddle"}</p>
                <p className="text-[0.82rem] text-ink-2">{analyzing ? "Goal cards appear below as each one is checked." : live ? "Each phone can add its own mic. Lines show up for everyone." : "Say what you're planning, like “we want to open a second location”."}</p>
              </>
            )}
            {live ? (
              <Button className="mt-2.5" variant="primary" onClick={finish} disabled={busy || !!playing}>
                <IconStop size={16} /> End Huddle &amp; find my goals
              </Button>
            ) : null}
          </div>
        </div>

        {!sup.secure || (!sup.speech && !sup.recorder) ? (
          <p className="mt-3 rounded-lg bg-watch-soft px-3 py-2 text-[0.8rem] text-watch">
            {sup.secure ? "This browser can't capture voice." : "The mic needs HTTPS."} Use a sample Huddle or the text box below.
          </p>
        ) : null}
        {error ? <p role="alert" className="mt-3 rounded-lg bg-watch-soft px-3 py-2 text-[0.82rem] text-watch">{error}</p> : null}

        {/* Live transcript, shared by everyone. */}
        {huddle && (lines.length || interim || live) ? (
          <div className="mt-4">
            <h3 className="mb-1.5 flex items-center gap-2 text-[0.78rem] font-semibold uppercase tracking-wide text-ink-2">
              Live transcript <span className="num font-normal normal-case text-ink-3">{lines.length} lines · {people.length} in room</span>
            </h3>
            <div ref={logRef} className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-line bg-surface-2 p-3" role="log" aria-live="polite">
              {lines.map((l) => (
                <p key={l.id} className="anim-fade flex gap-2 text-[0.9rem] leading-snug">
                  <Avatar name={l.speaker} size={22} />
                  <span><span className="font-semibold">{l.speaker === me ? `${l.speaker} (you)` : l.speaker}</span> <span className="text-ink-2">{l.text}</span></span>
                </p>
              ))}
              {interim ? <p className="text-[0.88rem] italic text-ink-3">{interim}…</p> : null}
              {!lines.length && !interim ? <p className="text-sm text-ink-3">Listening… start talking.</p> : null}
            </div>
          </div>
        ) : huddle?.status === "done" ? (
          <p className="mt-4 rounded-xl border border-dashed border-line-strong px-3 py-3 text-[0.82rem] text-ink-2">
            Transcript deleted after analysis. Only the goals and short quotes below are kept.
          </p>
        ) : null}

        {/* No mic? Zero dead ends. */}
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-[0.78rem] font-semibold uppercase tracking-wide text-ink-2">No mic? Try one of these</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {conversations.map((c) => (
              <Button
                key={c.id}
                size="sm"
                variant="secondary"
                disabled={busyAny || analyzing || capturing || (live && lines.length > 0)}
                onClick={() => (playing === c.id ? (abortRef.current = true) : void playSample(c))}
                title={live && lines.length > 0 ? "End the current Huddle first" : undefined}
              >
                {playing === c.id ? <><IconStop size={14} /> Stop sample</> : <><IconPlay size={14} /> Play: {c.title}</>}
              </Button>
            ))}
            {!conversations.length ? <p className="text-sm text-ink-3">No sample Huddles for this household.</p> : null}
          </div>
          <form
            className="mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitText();
            }}
          >
            <label htmlFor="huddle-text" className="text-sm font-medium">Or type what the family said</label>
            <textarea
              id="huddle-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              disabled={busyAny || analyzing || capturing}
              placeholder={"We want to pay off the Visa by March and open a second bakery location.\n(Tip: start a line with “Name:” to label who said it.)"}
              className="mt-1 w-full resize-y rounded-xl border border-line-strong bg-bg p-3 text-[0.92rem] outline-none focus:border-brand"
            />
            <Button type="submit" className="mt-2" disabled={!text.trim() || busyAny || analyzing || capturing}>
              <IconSend size={16} /> Analyze this
            </Button>
          </form>
        </div>
      </Card>

      {/* The agents' work, live. */}
      {run && (analyzing || huddle?.status === "done" || events.length) ? (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-display text-base font-semibold">What the agents are doing</h3>
            <Button size="sm" variant="ghost" onClick={() => openTrace(run.run_id)}>Full trace</Button>
          </div>
          <TraceTimeline events={events.slice(-9)} running={run.status === "running"} compact />
          {events.length > 9 ? <p className="mt-1 text-[0.75rem] text-ink-3">Showing the latest 9 of {events.length} steps.</p> : null}
        </Card>
      ) : null}
    </section>
  );
}
