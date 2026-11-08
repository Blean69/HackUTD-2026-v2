"use client";
import { useNow } from "@/lib/data/finance-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconMic, IconPlay, IconSend, IconShield, IconStop } from "@/components/icons";
import { ProviderBadge, runProviders } from "@/components/trace/badges";
import { TraceTimeline } from "@/components/trace/TraceTimeline";
import { Avatar, Button, Chip, Disclosure, Empty, ErrorNote, LivePill, Notice, PageHeader, Panel, Skeleton, type Tone } from "@/components/ui";
import { appendTranscript, endHuddle, startHuddle } from "@/lib/data/actions";
import { useConversations, useGoals, useHuddle, useLatestRun, usePresence, useRoomTables, useTraceEvents, useTranscript } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx, longDate, usd } from "@/lib/format";
import { openTrace } from "@/lib/traceUi";
import type { Conversation, Feasibility, Goal } from "@/lib/types";
import { pressTablePushToTalk, releaseTablePushToTalk, setTablePushToTalk, useTableVoice, VoiceCapture, voiceSupport } from "@/lib/voice";
import { HOLD_TO_TALK_CLASS, holdToTalkProps } from "@/lib/voiceCall/hold";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

const FEAS: Record<Exclude<Feasibility, "">, { tone: Tone; label: string; hint: string }> = {
  on_track: { tone: "good", label: "On track", hint: "Fits your current cash and surplus" },
  stretch: { tone: "watch", label: "Stretch", hint: "Possible with trade-offs or financing" },
  off_track: { tone: "risk", label: "Off track", hint: "Not reachable on today's numbers" },
  needs_details: { tone: "neutral", label: "Needs an amount", hint: "No amount was mentioned yet, so there is nothing to check. Add one on the Goals page." },
  not_advised: { tone: "risk", label: "Not advised", hint: "Gambling or speculation: not something we score as a plan." },
};

const textareaCls =
  "w-full resize-y rounded-md border border-line-strong bg-surface p-3 text-body text-ink outline-none placeholder:text-ink-3 focus:border-brand disabled:bg-surface-2 disabled:opacity-70";

function GoalCard({ g }: { g: Goal }) {
  const now = useNow(); // a blank status reads "Checking" only while the card is fresh
  const f = g.feasibility ? FEAS[g.feasibility] : null;
  return (
    <li className="anim-fade rounded-md border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lead font-semibold leading-snug">{g.title}</h3>
        {f ? <Chip tone={f.tone} title={f.hint}>{f.label}</Chip> : <Chip>{now.getTime() - Date.parse(g.updated_at) < 5 * 60_000 ? "Checking…" : "Not checked"}</Chip>}
      </div>
      {g.target_amount || g.target_date ? (
        <p className="num mt-0.5 text-label text-ink-2">
          {g.target_amount ? <span className="font-semibold text-ink">{usd(g.target_amount)}</span> : null}
          {g.target_amount && g.target_date ? " by " : null}
          {g.target_date ? longDate(g.target_date) : null}
        </p>
      ) : null}
      {g.evidence_quote ? (
        <blockquote className="mt-2 line-clamp-2 border-l-2 border-line-strong pl-3 text-label italic leading-snug text-ink-2">“{g.evidence_quote}”</blockquote>
      ) : null}
    </li>
  );
}

/** Table Mode: an opt-in, session-based conversation capture. Agents turn what the family says into goal cards. */
export function TableMode({ householdId }: { householdId: string }) {
  const ident = useLocalIdentity();
  const me = ident.name ?? "Someone";
  const ready = useRoomTables(householdId, ["conversation", "transcript_line", "goal"]);
  const huddle = useHuddle(householdId);
  const lines = useTranscript(huddle?.id);
  const conversations = useConversations(householdId);
  const people = usePresence(householdId);
  const run = useLatestRun(householdId, "huddle");
  // Only the latest run's steps are shown, so only those are loaded (the whole household's trace is the heaviest table).
  useRoomTables(householdId, run ? [`trace_event@${run.run_id}`] : []);
  const events = useTraceEvents(run?.run_id);
  const allGoals = useGoals(householdId);

  const voice = useTableVoice();
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
  const showTranscript = !!huddle && (lines.length > 0 || !!interim || live);
  const showGoals = goals.length > 0 || analyzing;
  const providers = runProviders(events);
  const idle = busyAny || analyzing || capturing;

  return (
    <>
      <PageHeader
        title="Table Mode"
        sub="Talk it out together. The agents turn it into goals."
        right={
          <>
            {capturing ? <LivePill label="Recording" /> : live ? <LivePill /> : <Chip tone={status.tone}>{status.text}</Chip>}
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
        {/* ------------------------------------------------------------ start */}
        <Panel id="table-start" title="Start a session">
          <p className="flex items-start gap-2 text-label text-ink-2">
            <IconShield size={16} className="mt-0.5 shrink-0 text-brand-strong" />
            <span>
              Opt-in: nothing is heard until someone taps the mic
              {huddle?.consent_names.length ? <>. Recording: <span className="font-medium text-ink">{huddle.consent_names.join(", ")}</span></> : null}.
              The transcript is deleted once goals are extracted.
            </span>
          </p>

          {/* Visible to EVERY phone in the room while a session is live. */}
          {live && huddle ? (
            <div role="status" className="mt-3 flex items-start gap-2 rounded-md border border-risk/25 bg-risk-soft px-3 py-2 text-label font-medium text-risk">
              <span className="anim-blink mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-rec" aria-hidden="true" />
              <span>Table Mode is live, started by {huddle.started_by_name}. Everyone in the room sees this transcript.</span>
            </div>
          ) : null}

          <div className="mt-4 flex items-center gap-4">
            <button
              type="button"
              onClick={() => void toggleMic()}
              disabled={busy || !!playing || analyzing}
              aria-pressed={capturing}
              aria-label={capturing ? "Stop recording" : live ? "Add my microphone to Table Mode" : "Start Table Mode with my microphone"}
              className={cx(
                "press relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50",
                capturing ? "anim-rec bg-rec text-white" : "bg-brand text-brand-ink hover:bg-brand-hover",
              )}
            >
              {capturing ? <IconStop size={30} /> : <IconMic size={32} />}
            </button>
            <div className="min-w-0 flex-1">
              {capturing ? (
                <>
                  <p className="flex items-center gap-2 text-h3 font-semibold text-rec">
                    <span className="anim-blink h-2.5 w-2.5 rounded-full bg-rec" aria-hidden="true" />
                    Recording · <span className="num">{mmss(secs)}</span>
                  </p>
                  <p className="mt-0.5 text-label text-ink-2">Tap to stop. {mode === "nvidia-asr" ? "Transcribed by NVIDIA ASR." : "Live captions from your browser."}</p>
                </>
              ) : (
                <>
                  <p className="text-h3 font-semibold">{live ? "Add my mic to this session" : analyzing ? "Agents are working…" : "Tap to talk"}</p>
                  <p className="mt-0.5 text-label text-ink-2">
                    {analyzing ? "Goal cards appear as each one is checked." : live ? "Each phone can add its own mic." : "Say what you're planning, like “we want to open a second location”."}
                  </p>
                </>
              )}
              {live ? (
                <Button className="mt-2.5" onClick={() => void finish()} disabled={busy || !!playing}>
                  <IconStop size={15} /> End session &amp; find goals
                </Button>
              ) : null}
            </div>
          </div>

          {/* Hold to talk: for a noisy room or an echoing speaker. The mic only listens while the button is held. */}
          <div className="mt-4 rounded-lg bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="table-ptt" className="min-w-0 cursor-pointer">
                <span className="block text-label font-medium text-ink">Noisy room? Hold to talk</span>
                <span className="block text-caption text-ink-3">The mic listens only while you hold the button.</span>
              </label>
              <button
                id="table-ptt"
                type="button"
                role="switch"
                aria-checked={voice.pushToTalk}
                onClick={() => setTablePushToTalk(!voice.pushToTalk)}
                className={cx("press relative h-6 w-10 shrink-0 rounded-full transition-colors", voice.pushToTalk ? "bg-brand" : "bg-line-strong")}
              >
                <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-surface transition-transform", voice.pushToTalk ? "translate-x-[1.125rem]" : "translate-x-0.5")} aria-hidden="true" />
              </button>
            </div>
            {capturing ? (
              <p className="mt-2.5 flex items-center gap-2 text-label font-medium" role="status" aria-live="polite">
                <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", voice.micLive ? "anim-blink bg-rec" : "bg-ink-3")} aria-hidden="true" />
                <span className={voice.micLive ? "text-rec" : "text-ink-2"}>{voice.micLive ? "Mic live: listening" : "Mic paused"}</span>
              </p>
            ) : null}
            {voice.pushToTalk && capturing ? (
              <button
                type="button"
                {...holdToTalkProps(pressTablePushToTalk, releaseTablePushToTalk)}
                aria-pressed={voice.held}
                className={cx(
                  HOLD_TO_TALK_CLASS,
                  "mt-3 flex h-20 w-full items-center justify-center gap-2.5 rounded-xl border-2 text-lead font-semibold transition-colors",
                  voice.held ? "border-rec bg-rec text-white" : "border-brand bg-surface text-brand-strong hover:bg-brand-soft",
                )}
              >
                <IconMic size={22} />
                {voice.held ? "Listening… release to send" : "Hold to talk"}
              </button>
            ) : voice.pushToTalk ? (
              <p className="mt-2 text-caption text-ink-3">Tap the mic to start; then hold the button that appears while you speak (Space works too).</p>
            ) : null}
          </div>

          {!sup.secure || (!sup.speech && !sup.recorder) ? (
            <Notice tone="warn" className="mt-3">
              {sup.secure ? "This browser can't capture voice." : "The mic needs HTTPS."} Play a sample below or type instead.
            </Notice>
          ) : null}
          {error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}

          <div className="mt-5 border-t border-line pt-4">
            <h3 className="text-label font-semibold text-ink-2">No mic? Play a sample conversation</h3>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {!ready ? <Skeleton className="h-10 w-full sm:w-64" /> : null}
              {ready ? conversations.map((c) => (
                <Button
                  key={c.id}
                  variant="secondary"
                  className="!h-auto min-h-10 max-w-full !shrink justify-start !whitespace-normal !py-2 text-left"
                  disabled={idle || (live && lines.length > 0)}
                  onClick={() => (playing === c.id ? (abortRef.current = true) : void playSample(c))}
                  title={live && lines.length > 0 ? "End the current session first" : undefined}
                >
                  {playing === c.id ? <><IconStop size={14} /> Stop sample</> : <><IconPlay size={14} /> {c.title}</>}
                </Button>
              )) : null}
              {ready && !conversations.length ? <p className="text-label text-ink-3">No sample conversations for this household.</p> : null}
            </div>

            <Disclosure summary="Or type what the family said" className="mt-4">
              <form
                className="mt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitText();
                }}
              >
                <label htmlFor="table-text" className="sr-only">What the family said</label>
                <textarea
                  id="table-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  disabled={idle}
                  placeholder={"We want to pay off the Visa by March and open a second bakery location.\n(Start a line with “Name:” to say who spoke.)"}
                  className={textareaCls}
                />
                <Button type="submit" className="mt-2" disabled={!text.trim() || idle}>
                  <IconSend size={15} /> Analyse this
                </Button>
              </form>
            </Disclosure>
          </div>
        </Panel>

        {/* ------------------------------------------------------------ live results */}
        <div className="space-y-3">
          {showTranscript ? (
            <Panel id="table-transcript" title="Live transcript" right={<span className="num text-caption text-ink-3">{lines.length} lines · {people.length} in room</span>}>
              <div
                ref={logRef}
                role="log"
                aria-live="polite"
                aria-label="Shared transcript"
                className="max-h-72 space-y-2.5 overflow-y-auto rounded-md bg-surface-2 p-3"
              >
                {lines.map((l) => (
                  <p key={l.id} className="anim-fade flex gap-2 text-body leading-snug">
                    <Avatar name={l.speaker} size={24} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="font-semibold">{l.speaker === me ? `${l.speaker} (you)` : l.speaker}</span>{" "}
                      <span className="text-ink-2">{l.text}</span>
                    </span>
                  </p>
                ))}
                {interim ? <p className="text-body italic text-ink-3">{interim}…</p> : null}
                {!lines.length && !interim ? <p className="text-label text-ink-3">Listening… start talking.</p> : null}
              </div>
            </Panel>
          ) : null}

          {agentsVisible && run ? (
            <Panel
              id="table-agents"
              title="Agent steps"
              right={<Button size="sm" variant="secondary" onClick={() => openTrace(run.run_id)}>Full trace</Button>}
            >
              {providers.length ? (
                <div className="-mt-1 mb-3 flex flex-wrap gap-1">{providers.map((e) => <ProviderBadge key={`${e.model}${e.provider}`} model={e.model} provider={e.provider} />)}</div>
              ) : null}
              <TraceTimeline events={events.slice(-4)} running={run.status === "running"} compact />
              {events.length > 4 ? <p className="text-caption text-ink-3">Latest 4 of {events.length} steps.</p> : null}
            </Panel>
          ) : null}

          {showGoals ? (
            <Panel id="table-goals" title="Goals from this session">
              {goals.length ? (
                <ul className="space-y-2.5" aria-label="Goal cards">
                  {goals.map((g) => <GoalCard key={g.id} g={g} />)}
                </ul>
              ) : (
                <Empty title="Agents are checking each goal…">Goal cards appear here as they are checked.</Empty>
              )}
            </Panel>
          ) : null}

          {!showTranscript && !agentsVisible && !showGoals ? (
            <Panel id="table-results" title="Results">
              <Empty title={done ? "Transcript deleted after analysis" : "Nothing yet"}>
                {done ? "Only the goals and short quotes are kept." : "The transcript, the agents' steps and the goals appear here for everyone in the room."}
              </Empty>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
