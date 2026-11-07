"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconMic, IconPlay, IconSend, IconShield, IconStop } from "@/components/icons";
import { TraceTimeline } from "@/components/trace/TraceTimeline";
import { Avatar, Button, Chip, Empty, LivePill, PageHeader, Panel, type Tone } from "@/components/ui";
import { appendTranscript, endHuddle, startHuddle } from "@/lib/data/actions";
import { useConversations, useGoals, useHuddle, useLatestRun, usePresence, useTraceEvents, useTranscript } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx, longDate, usd } from "@/lib/format";
import { openTrace } from "@/lib/traceUi";
import type { Conversation, Feasibility, Goal } from "@/lib/types";
import { VoiceCapture, voiceSupport } from "@/lib/voice";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

const FEAS: Record<Exclude<Feasibility, "">, { tone: Tone; label: string; hint: string }> = {
  on_track: { tone: "good", label: "On track", hint: "Fits your current cash and surplus" },
  stretch: { tone: "watch", label: "Stretch", hint: "Possible with trade-offs or financing" },
  off_track: { tone: "risk", label: "Off track", hint: "Not reachable on today's numbers" },
};
const PRIORITY: Record<Goal["priority"], string> = { high: "High priority", medium: "Medium priority", low: "Low priority" };

const textareaCls =
  "w-full resize-y rounded-md border border-line-strong bg-surface p-3 text-[0.9rem] text-ink outline-none placeholder:text-ink-3 focus:border-brand disabled:bg-surface-2 disabled:opacity-70";

function GoalCard({ g }: { g: Goal }) {
  const f = g.feasibility ? FEAS[g.feasibility] : null;
  return (
    <li className="anim-fade rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {f ? <Chip tone={f.tone} title={f.hint}>{f.label}</Chip> : <Chip>Checking…</Chip>}
        <span className="text-[0.74rem] text-ink-3">{PRIORITY[g.priority]}</span>
      </div>
      <h3 className="mt-1.5 text-[0.95rem] font-semibold leading-snug">{g.title}</h3>
      {g.target_amount || g.target_date ? (
        <p className="num mt-0.5 text-[0.84rem] text-ink-2">
          {g.target_amount ? <span className="font-semibold text-ink">{usd(g.target_amount)}</span> : null}
          {g.target_amount && g.target_date ? " by " : null}
          {g.target_date ? longDate(g.target_date) : null}
        </p>
      ) : null}
      {g.evidence_quote ? (
        <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-[0.8rem] italic leading-snug text-ink-2">“{g.evidence_quote}”</blockquote>
      ) : null}
    </li>
  );
}

/** Table Mode: an opt-in, session-based conversation capture. Agents turn what the family says into goal cards. */
export function TableMode({ householdId }: { householdId: string }) {
  const ident = useLocalIdentity();
  const me = ident.name ?? "Someone";
  const huddle = useHuddle(householdId);
  const lines = useTranscript(huddle?.id);
  const conversations = useConversations(householdId);
  const people = usePresence(householdId);
  const run = useLatestRun(householdId, "huddle");
  const events = useTraceEvents(run?.run_id);
  const allGoals = useGoals(householdId);

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
  const done = huddle?.status === "done";
  const busyAny = busy || !!playing;
  const since = huddle?.started_at;
  const goals = useMemo(
    () => (since ? allGoals.filter((g) => g.source === "huddle" && (g.updated_at || g.created_at) >= since) : []),
    [allGoals, since],
  );

  // Stop everything if the user leaves the page mid-session.
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

  async function ensureSession(consent: string[]): Promise<string> {
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
      const id = await ensureSession([me]);
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
      setError(e instanceof Error ? e.message : "Couldn't start Table Mode");
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
      const id = await ensureSession([`${me} (sample: ${c.title})`]);
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
      const id = await ensureSession([me]);
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

  const status: { tone: Tone; text: string } = capturing
    ? { tone: "risk", text: "Recording on this phone" }
    : live
      ? { tone: "risk", text: "Live" }
      : analyzing
        ? { tone: "brand", text: "Agents analysing" }
        : done
          ? { tone: "good", text: "Analysis done" }
          : { tone: "neutral", text: "Not started" };

  const agentsVisible = !!run && (analyzing || done || events.length > 0);

  return (
    <>
      <PageHeader
        title="Table Mode"
        sub="Talk it out together. Agents turn the conversation into goals and check each one against your real accounts."
        right={
          <>
            {live || capturing ? <LivePill /> : null}
            <Chip tone={status.tone}>{status.text}</Chip>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        {/* ------------------------------------------------------------ controls */}
        <div className="space-y-4">
          <Panel title="Capture" sub="One shared session for everyone at the table.">
            <p className="flex items-start gap-2 text-[0.8rem] leading-snug text-ink-2">
              <IconShield size={16} className="mt-0.5 shrink-0 text-brand" />
              <span>
                Opt-in only: nothing is heard until someone taps the mic, and only the people listed here are recorded
                {huddle?.consent_names.length ? <> (<span className="font-medium text-ink">{huddle.consent_names.join(", ")}</span>)</> : null}.
                The transcript is deleted once goals are extracted.
              </span>
            </p>

            {/* Visible to EVERY phone in the room while a session is live. */}
            {live && huddle ? (
              <div role="status" className="mt-3 flex items-start gap-2 rounded-md bg-risk-soft px-3 py-2 text-[0.82rem] font-medium leading-snug text-risk">
                <span className="anim-blink mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-rec" aria-hidden="true" />
                <span>Table Mode is live, started by {huddle.started_by_name}. Everyone in the room sees this transcript.</span>
              </div>
            ) : null}

            <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:gap-5">
              <button
                type="button"
                onClick={() => void toggleMic()}
                disabled={busy || !!playing || analyzing}
                aria-pressed={capturing}
                aria-label={capturing ? "Stop recording" : live ? "Add my microphone to Table Mode" : "Start Table Mode with my microphone"}
                className={cx(
                  "relative flex h-24 w-24 shrink-0 items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-50",
                  capturing ? "anim-rec bg-rec text-white" : "bg-brand text-brand-ink hover:bg-brand-strong",
                )}
              >
                {capturing ? <IconStop size={34} /> : <IconMic size={38} />}
              </button>
              <div className="min-w-0 flex-1 text-center sm:text-left">
                {capturing ? (
                  <>
                    <p className="flex items-center justify-center gap-2 text-[1rem] font-semibold text-rec sm:justify-start">
                      <span className="anim-blink h-2.5 w-2.5 rounded-full bg-rec" aria-hidden="true" />
                      Recording · <span className="num">{mmss(secs)}</span>
                    </p>
                    <p className="mt-0.5 text-[0.82rem] text-ink-2">Tap to stop. {mode === "nvidia-asr" ? "Transcribed by NVIDIA ASR." : "Live captions from your browser."}</p>
                  </>
                ) : (
                  <>
                    <p className="text-[1rem] font-semibold">{live ? "Add my mic to this session" : analyzing ? "Agents are working…" : "Tap to start Table Mode"}</p>
                    <p className="mt-0.5 text-[0.82rem] text-ink-2">
                      {analyzing
                        ? "Goal cards appear as each one is checked."
                        : live
                          ? "Each phone can add its own mic. Lines show up for everyone."
                          : "Say what you're planning, like “we want to open a second location”."}
                    </p>
                  </>
                )}
                {live ? (
                  <Button className="mt-3" onClick={() => void finish()} disabled={busy || !!playing}>
                    <IconStop size={15} /> End session &amp; find our goals
                  </Button>
                ) : null}
              </div>
            </div>

            {!sup.secure || (!sup.speech && !sup.recorder) ? (
              <p className="mt-3 rounded-md bg-watch-soft px-3 py-2 text-[0.8rem] text-watch">
                {sup.secure ? "This browser can't capture voice." : "The mic needs HTTPS."} Play a sample conversation or use the text box below.
              </p>
            ) : null}
            {error ? <p role="alert" className="mt-3 rounded-md bg-watch-soft px-3 py-2 text-[0.82rem] text-watch">{error}</p> : null}
          </Panel>

          <Panel title="No mic? Try one of these" sub="Zero dead ends: a sample conversation or typed text runs the same agents.">
            <h3 className="text-[0.78rem] font-semibold text-ink-2">Play a sample conversation</h3>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {conversations.map((c) => (
                <Button
                  key={c.id}
                  variant="secondary"
                  className="justify-start"
                  disabled={busyAny || analyzing || capturing || (live && lines.length > 0)}
                  onClick={() => (playing === c.id ? (abortRef.current = true) : void playSample(c))}
                  title={live && lines.length > 0 ? "End the current session first" : undefined}
                >
                  {playing === c.id ? <><IconStop size={14} /> Stop sample</> : <><IconPlay size={14} /> {c.title}</>}
                </Button>
              ))}
              {!conversations.length ? <p className="text-[0.84rem] text-ink-3">No sample conversations for this household.</p> : null}
            </div>

            <form
              className="mt-4 border-t border-line pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submitText();
              }}
            >
              <label htmlFor="table-text" className="text-[0.78rem] font-semibold text-ink-2">Or type what the family said</label>
              <textarea
                id="table-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                disabled={busyAny || analyzing || capturing}
                placeholder={"We want to pay off the Visa by March and open a second bakery location.\n(Tip: start a line with “Name:” to label who said it.)"}
                className={cx(textareaCls, "mt-1.5")}
              />
              <Button type="submit" className="mt-2" disabled={!text.trim() || busyAny || analyzing || capturing}>
                <IconSend size={15} /> Analyse this
              </Button>
            </form>
          </Panel>
        </div>

        {/* ------------------------------------------------------------ live results */}
        <div className="space-y-4">
          <Panel
            title="Live transcript"
            sub="Shared with everyone in the room."
            right={<span className="num text-[0.76rem] text-ink-3">{lines.length} lines · {people.length} in room</span>}
          >
            {huddle && (lines.length > 0 || !!interim || live) ? (
              <div
                ref={logRef}
                role="log"
                aria-live="polite"
                aria-label="Shared transcript"
                className="max-h-80 space-y-2.5 overflow-y-auto rounded-md border border-line bg-surface-2 p-3"
              >
                {lines.map((l) => (
                  <p key={l.id} className="anim-fade flex gap-2 text-[0.88rem] leading-snug">
                    <Avatar name={l.speaker} size={24} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="font-semibold">{l.speaker === me ? `${l.speaker} (you)` : l.speaker}</span>{" "}
                      <span className="text-ink-2">{l.text}</span>
                    </span>
                  </p>
                ))}
                {interim ? <p className="text-[0.86rem] italic text-ink-3">{interim}…</p> : null}
                {!lines.length && !interim ? <p className="text-[0.84rem] text-ink-3">Listening… start talking.</p> : null}
              </div>
            ) : done ? (
              <Empty title="Transcript deleted after analysis">Only the goals and short quotes below are kept.</Empty>
            ) : (
              <Empty title="Nothing recorded yet">The shared transcript appears here for everyone in the room once Table Mode starts.</Empty>
            )}
          </Panel>

          <Panel
            title="Agent progress"
            sub="What the agents are doing, live."
            right={run ? <Button size="sm" variant="secondary" onClick={() => openTrace(run.run_id)}>Full trace</Button> : undefined}
          >
            {agentsVisible && run ? (
              <>
                <TraceTimeline events={events.slice(-9)} running={run.status === "running"} compact />
                {events.length > 9 ? <p className="mt-1 text-[0.76rem] text-ink-3">Showing the latest 9 of {events.length} steps.</p> : null}
              </>
            ) : (
              <Empty title="No analysis yet">Agent steps stream in here as soon as a session ends.</Empty>
            )}
          </Panel>

          <Panel title="Goals from this session" sub="Checked against your real balances by the agents.">
            {goals.length ? (
              <ul className="space-y-2.5" aria-label="Goal cards">
                {goals.map((g) => <GoalCard key={g.id} g={g} />)}
              </ul>
            ) : (
              <Empty title={analyzing ? "Agents are checking each goal…" : "No goals yet"}>
                {analyzing ? "Goal cards appear here as they are checked." : "End a session and the agents will turn the conversation into goals."}
              </Empty>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
