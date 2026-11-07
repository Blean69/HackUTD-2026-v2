"use client";
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconSend, IconSpark, IconWrench } from "@/components/icons";
import { Avatar, Button, Chip, inputCls } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { askCoach } from "@/lib/data/actions";
import { useCoachMessages, useLatestRun, useTraceEvents } from "@/lib/data/hooks";
import { cx } from "@/lib/format";
import { openTrace } from "@/lib/traceUi";
import type { CoachMessage, TraceEvent } from "@/lib/types";

const SUGGESTIONS = ["Can we afford the second location?", "What should we pay off first?", "How is our emergency fund?", "Is anything suspicious on our accounts?"];

function AssistantMark() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-strong" aria-hidden="true">
      <IconSpark size={15} />
    </span>
  );
}

/** Tool calls the assistant made, shown as small chips above its answer. */
function ToolCalls({ events, running }: { events: readonly TraceEvent[]; running?: boolean }) {
  const rows = events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
  if (!rows.length && !running) return null;
  return (
    <ul className="mb-2 space-y-1" aria-label={`Tools ${PRODUCT_NAME} used`}>
      {rows.map((e) => (
        <li
          key={e.id}
          className={cx(
            "flex items-start gap-1.5 rounded-md border px-2 py-1 text-[0.74rem] leading-snug",
            e.type === "tool_call" ? "border-line-strong bg-surface font-mono text-ink" : "border-transparent bg-surface text-ink-2",
          )}
        >
          {e.type === "tool_call" ? <IconWrench size={13} className="mt-0.5 shrink-0 text-ink-3" /> : <IconCheck size={13} className="mt-0.5 shrink-0 text-good" />}
          <span className="min-w-0 break-words">{e.title}</span>
        </li>
      ))}
      {running ? (
        <li className="flex items-center gap-2 px-0.5 pt-0.5 text-[0.78rem] text-ink-2">
          <span className="anim-blink h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" /> {PRODUCT_NAME} is checking your accounts…
        </li>
      ) : null}
    </ul>
  );
}

function Bubble({ m, me }: { m: CoachMessage; me: string }) {
  const events = useTraceEvents(m.run_id || undefined);
  const mine = m.role === "user";
  return (
    <li className={cx("anim-fade flex gap-2", mine && "flex-row-reverse")}>
      {mine ? <Avatar name={m.author_name} size={28} /> : <AssistantMark />}
      <div className={cx("max-w-[88%] rounded-lg px-3 py-2", mine ? "bg-brand text-brand-ink" : "border border-line bg-surface-2")}>
        <p className={cx("mb-0.5 text-[0.72rem] font-semibold", mine ? "text-brand-ink/80" : "text-ink-3")}>
          {mine ? (m.author_name === me ? "You" : m.author_name) : PRODUCT_NAME}
        </p>
        {!mine ? <ToolCalls events={events} /> : null}
        <p className="whitespace-pre-wrap break-words text-[0.88rem] leading-relaxed">{m.text}</p>
        {!mine && m.run_id ? (
          <button type="button" onClick={() => openTrace(m.run_id)} className="mt-1.5 rounded text-[0.76rem] font-medium text-brand-strong hover:underline">
            How I got this
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Chat with the assistant, shown inside the "Ask <product>" slide-over (AppShell supplies the title). Fills the
 * slide-over: messages scroll, the suggestion chips and the input stay pinned to the bottom.
 */
export function CoachPanel({ householdId, me }: { householdId: string; me: string }) {
  const messages = useCoachMessages(householdId);
  const run = useLatestRun(householdId, "coach");
  const events = useTraceEvents(run?.run_id);
  const pending = run?.status === "running";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, events.length, pending]);

  async function send(t: string) {
    const q = t.trim();
    if (!q || busy || pending) return;
    setBusy(true);
    setErr(null);
    try {
      await askCoach(householdId, q, me);
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't send that question");
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || pending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" role="log" aria-live="polite" aria-label={`Conversation with ${PRODUCT_NAME}`}>
        {messages.length === 0 && !pending ? (
          <div className="rounded-md border border-dashed border-line-strong px-4 py-5 text-center">
            <p className="text-[0.88rem] font-medium">Ask about your money</p>
            <p className="mt-1 text-[0.8rem] text-ink-2">Try one of the questions below. Everyone in the household sees the conversation.</p>
          </div>
        ) : null}
        <ul className="space-y-3">
          {messages.map((m) => <Bubble key={m.id} m={m} me={me} />)}
          {pending ? (
            <li className="flex gap-2">
              <AssistantMark />
              <div className="max-w-[88%] rounded-lg border border-line bg-surface-2 px-3 py-2">
                <p className="mb-0.5 text-[0.72rem] font-semibold text-ink-3">{PRODUCT_NAME}</p>
                <ToolCalls events={events} running />
              </div>
            </li>
          ) : null}
        </ul>
      </div>

      <div className="pb-safe shrink-0 border-t border-line bg-surface px-4 pt-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested questions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={locked}
              onClick={() => void send(s)}
              className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-left text-[0.78rem] font-medium leading-snug text-ink-2 transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
        {err ? <p role="alert" className="mt-2 text-[0.8rem] text-risk">{err}</p> : null}
        <form className="mt-2.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <label htmlFor="coach-in" className="sr-only">Ask {PRODUCT_NAME}</label>
          <input id="coach-in" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${PRODUCT_NAME}…`} autoComplete="off" className={cx(inputCls, "min-w-0 flex-1")} />
          <Button type="submit" disabled={locked || !text.trim()} aria-label="Send question" className="w-10 px-0">
            <IconSend size={17} />
          </Button>
        </form>
        {pending ? (
          <p className="mt-2 flex items-center gap-1.5 text-[0.74rem] text-ink-3" role="status">
            <Chip tone="brand">Live</Chip> Tool calls appear as the agent makes them.
          </p>
        ) : null}
      </div>
    </div>
  );
}
