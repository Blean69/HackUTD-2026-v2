"use client";
import { useEffect, useRef, useState } from "react";
import { IconChevron, IconSend, IconWrench } from "@/components/icons";
import { Avatar, Button, Card, Chip, SectionTitle } from "@/components/ui";
import { askCoach } from "@/lib/data/actions";
import { useCoachMessages, useLatestRun, useTraceEvents } from "@/lib/data/hooks";
import { cx } from "@/lib/format";
import { openTrace } from "@/lib/traceUi";
import type { CoachMessage, TraceEvent } from "@/lib/types";

const SUGGESTIONS = ["Can we afford the second location?", "What should we pay off first?", "How is our emergency fund?", "Is anything suspicious on our accounts?"];

/** Tool calls the coach made, shown inline above its answer. */
function ToolCalls({ events, running }: { events: readonly TraceEvent[]; running?: boolean }) {
  const rows = events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
  if (!rows.length && !running) return null;
  return (
    <ul className="mb-2 space-y-1" aria-label="Tools the coach used">
      {rows.map((e) => (
        <li key={e.id} className={cx("flex items-start gap-2 rounded-lg px-2 py-1 font-mono text-[0.74rem] leading-snug", e.type === "tool_call" ? "bg-accent-soft text-watch" : "bg-surface-2 text-ink-2")}>
          {e.type === "tool_call" ? <IconWrench size={13} className="mt-0.5 shrink-0" /> : <IconChevron size={13} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 break-words">{e.title}</span>
        </li>
      ))}
      {running ? <li className="flex items-center gap-2 px-2 text-[0.78rem] text-ink-2"><span className="anim-blink h-2 w-2 rounded-full bg-brand" aria-hidden="true" /> Coach is thinking…</li> : null}
    </ul>
  );
}

function Bubble({ m, me }: { m: CoachMessage; me: string }) {
  const events = useTraceEvents(m.run_id || undefined);
  const mine = m.role === "user";
  return (
    <li className={cx("anim-fade flex gap-2", mine && "flex-row-reverse")}>
      <Avatar name={mine ? m.author_name : "Coach"} size={28} />
      <div className={cx("max-w-[86%] rounded-2xl px-3.5 py-2.5", mine ? "rounded-tr-md bg-brand text-brand-ink" : "rounded-tl-md border border-line bg-surface-2")}>
        <p className={cx("mb-0.5 text-[0.7rem] font-semibold", mine ? "text-brand-ink/80" : "text-ink-3")}>{mine ? (m.author_name === me ? "You" : m.author_name) : "Coach"}</p>
        {!mine ? <ToolCalls events={events} /> : null}
        <p className="whitespace-pre-wrap text-[0.92rem] leading-relaxed">{m.text}</p>
        {!mine && m.run_id ? (
          <button type="button" onClick={() => openTrace(m.run_id)} className="mt-1.5 text-[0.74rem] font-medium text-brand-strong underline-offset-2 hover:underline">How I got this</button>
        ) : null}
      </div>
    </li>
  );
}

export function CoachPanel({ householdId, me }: { householdId: string; me: string }) {
  const messages = useCoachMessages(householdId);
  const run = useLatestRun(householdId, "coach");
  const events = useTraceEvents(run?.run_id);
  const pending = run?.status === "running";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages.length, events.length]);

  async function send(t: string) {
    const q = t.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      await askCoach(householdId, q, me);
      setText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="coach-h" className="space-y-3">
      <SectionTitle id="coach-h" title="Coach" sub="Ask anything about your money. Answers come from tools run on your real accounts, shown below." />
      <Card className="p-4">
        <ul className="max-h-[26rem] space-y-3 overflow-y-auto pr-1" aria-live="polite" aria-label="Coach conversation">
          {messages.length === 0 && !pending ? (
            <li className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-sm text-ink-2">Try a question below. The whole family sees the conversation.</li>
          ) : null}
          {messages.map((m) => <Bubble key={m.id} m={m} me={me} />)}
          {pending ? (
            <li className="flex gap-2">
              <Avatar name="Coach" size={28} />
              <div className="max-w-[86%] rounded-2xl rounded-tl-md border border-line bg-surface-2 px-3.5 py-2.5">
                <ToolCalls events={events} running />
              </div>
            </li>
          ) : null}
          <li ref={endRef} aria-hidden="true" />
        </ul>
        <div className="no-scrollbar -mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={busy || pending} onClick={() => void send(s)} className="shrink-0 rounded-full border border-line-strong bg-surface px-3.5 py-2 text-[0.84rem] font-medium hover:border-brand hover:bg-brand-soft disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <label htmlFor="coach-in" className="sr-only">Ask the coach</label>
          <input id="coach-in" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the Coach…" className="h-12 min-w-0 flex-1 rounded-xl border border-line-strong bg-bg px-3 text-base outline-none focus:border-brand" />
          <Button type="submit" disabled={busy || pending || !text.trim()} aria-label="Send"><IconSend size={18} /></Button>
        </form>
        {pending ? <p className="mt-2 text-[0.75rem] text-ink-3"><Chip tone="brand">live</Chip> Tool calls appear as the agent makes them.</p> : null}
      </Card>
    </section>
  );
}
