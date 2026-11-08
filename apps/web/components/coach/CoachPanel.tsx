"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconSend, IconSpark, IconWrench } from "@/components/icons";
import { Avatar, Button, inputCls } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { askCoach } from "@/lib/data/actions";
import { useCoachMessages, useLatestRun, useRoomTables, useTraceEvents } from "@/lib/data/hooks";
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
            "flex items-start gap-1.5 rounded-md border px-2 py-1 text-caption leading-snug",
            e.type === "tool_call" ? "border-line-strong bg-surface font-mono text-ink" : "border-transparent bg-surface text-ink-2",
          )}
        >
          {e.type === "tool_call" ? <IconWrench size={13} className="mt-0.5 shrink-0 text-ink-3" /> : <IconCheck size={13} className="mt-0.5 shrink-0 text-good" />}
          <span className="min-w-0 break-words">{e.title}</span>
        </li>
      ))}
      {running ? (
        <li className="flex items-center gap-2 px-0.5 pt-0.5 text-label text-ink-2">
          <span className="anim-blink h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" /> {PRODUCT_NAME} is checking your accounts…
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The model answers in light markdown: **bold** and 【tool】 source tags. Render bold as bold and the tags as a quiet
 * mono label, instead of showing the raw asterisks and brackets. Everything else stays plain text (no HTML is parsed).
 */
function RichText({ text }: { text: string }) {
  // single *italic* / _italic_ markers and `code` ticks are dropped (bold is handled below)
  const clean = text.replace(/`([^`\n]+)`/g, "$1").replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s.,;:!?)]|$)/g, "$1$2");
  const parts = clean.split(/(\*\*[^*\n]+\*\*|【[^】\n]{1,40}】)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-semibold text-ink">{p.slice(2, -2)}</strong>
        ) : p.startsWith("【") && p.endsWith("】") ? (
          <span key={i} className="mx-0.5 rounded-sm bg-surface-3 px-1 font-mono text-2xs text-ink-3">{p.slice(1, -1).replace(/_/g, " ")}</span>
        ) : (
          p.replace(/\*\*/g, "")
        ),
      )}
    </>
  );
}

const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isRule = (line: string): boolean => /^\s*(?:[-*_]\s*){3,}$/.test(line) || /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * Block-level light markdown for answers: paragraphs, "- " / "1. " lists, "#" headings as bold lines, and pipe tables shown as
 * readable rows ("**Rewards Visa:** Balance $1,558.81 · APR 21.99%"), which read well on a phone. Horizontal rules are dropped.
 * Plain text only: nothing is parsed as HTML.
 */
function Answer({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || isRule(line)) {
      i++;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        if (!isRule(lines[i]!)) rows.push(cells(lines[i]!));
        i++;
      }
      const [head, ...body] = rows.length > 1 ? rows : [[], ...rows];
      blocks.push(
        <ul key={blocks.length} className="space-y-1">
          {body.map((r, k) => (
            <li key={k}>
              <RichText text={`**${r[0]?.replace(/\*\*/g, "") ?? ""}**${r.length > 1 ? ": " : ""}${r.slice(1).map((c, j) => (head?.[j + 1] ? `${head[j + 1]!.replace(/\*\*/g, "")} ${c}` : c)).join(" · ")}`} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i]!)) items.push(lines[i++]!.replace(bullet, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={blocks.length} className={cx("space-y-0.5 pl-5", ordered ? "list-decimal" : "list-disc")}>
          {items.map((t, k) => (
            <li key={k}>
              <RichText text={t} />
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const heading = /^\s*#{1,6}\s+/.test(line);
    const para: string[] = [];
    if (heading) para.push(line.replace(/^\s*#{1,6}\s+/, ""));
    else while (i < lines.length && lines[i]!.trim() && !isRule(lines[i]!) && !lines[i]!.trim().startsWith("|") && !bullet.test(lines[i]!) && !/^\s*#{1,6}\s+/.test(lines[i]!)) para.push(lines[i++]!);
    if (heading) i++;
    blocks.push(
      <p key={blocks.length} className={heading ? "font-semibold text-ink" : undefined}>
        <RichText text={para.join("\n")} />
      </p>,
    );
  }
  return <div className="space-y-2">{blocks}</div>;
}

function Bubble({ m, me }: { m: CoachMessage; me: string }) {
  const events = useTraceEvents(m.run_id || undefined);
  const mine = m.role === "user";
  return (
    <li className={cx("anim-fade flex gap-2", mine && "flex-row-reverse")}>
      {mine ? <Avatar name={m.author_name} size={28} /> : <AssistantMark />}
      <div className={cx("max-w-[88%] rounded-lg px-3 py-2", mine ? "bg-brand text-brand-ink" : "border border-line bg-surface-2")}>
        <p className={cx("mb-0.5 text-caption font-semibold", mine ? "text-brand-ink/80" : "text-ink-3")}>
          {mine ? (m.author_name === me ? "You" : m.author_name) : PRODUCT_NAME}
        </p>
        {!mine ? <ToolCalls events={events} /> : null}
        {mine ? <p className="whitespace-pre-wrap break-words text-body leading-relaxed">{m.text}</p> : <div className="whitespace-pre-wrap break-words text-body leading-relaxed"><Answer text={m.text} /></div>}
        {!mine && m.run_id ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
            {/* The advice guard (worker advice_guard.ts) writes "Advice check (...): ..." into the run; show its verdict. */}
            {events.some((e) => /^Advice check \([^)]*\): passed/.test(e.title)) ? (
              <span className="inline-flex items-center gap-1 font-medium text-good"><IconCheck size={13} />Checked against your accounts</span>
            ) : null}
            <button type="button" onClick={() => openTrace(m.run_id)} className="rounded font-medium text-brand-strong hover:underline">
              How I got this
            </button>
          </p>
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
  // Mounted only while the slide-over is open, so the conversation and its tool calls load on open, not on every page.
  const ready = useRoomTables(householdId, ["coach_message"]);
  const messages = useCoachMessages(householdId);
  const run = useLatestRun(householdId, "coach");
  // Tool calls under each answer come from that answer's run: load the last few runs, not the whole household's trace.
  const latestRunId = run?.run_id;
  const traceKeys = useMemo(() => {
    const ids = new Set(messages.map((m) => m.run_id).filter(Boolean).slice(-4));
    if (latestRunId) ids.add(latestRunId);
    return [...ids].map((id) => `trace_event@${id}` as const);
  }, [messages, latestRunId]);
  useRoomTables(householdId, traceKeys);
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
        {!ready ? <p className="py-6 text-center text-label text-ink-3" role="status">Loading the conversation…</p> : null}
        {ready && messages.length === 0 && !pending ? (
          <div className="rounded-md border border-dashed border-line-strong px-4 py-5 text-center">
            <p className="text-body font-medium">Ask about your money</p>
            <p className="mt-1 text-label text-ink-2">Pick a question below. The whole household sees the answer.</p>
          </div>
        ) : null}
        <ul className="space-y-3">
          {messages.map((m) => <Bubble key={m.id} m={m} me={me} />)}
          {pending ? (
            <li className="flex gap-2">
              <AssistantMark />
              <div className="max-w-[88%] rounded-lg border border-line bg-surface-2 px-3 py-2">
                <p className="mb-0.5 text-caption font-semibold text-ink-3">{PRODUCT_NAME}</p>
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
              className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-left text-label font-medium leading-snug text-ink-2 transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
        {err ? <p role="alert" className="mt-2 text-label text-risk">{err}</p> : null}
        <form className="mt-2.5 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <label htmlFor="coach-in" className="sr-only">Ask {PRODUCT_NAME}</label>
          <input id="coach-in" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${PRODUCT_NAME}…`} autoComplete="off" className={cx(inputCls, "min-w-0 flex-1")} />
          <Button type="submit" disabled={locked || !text.trim()} aria-label="Send question" className="w-10 px-0">
            <IconSend size={17} />
          </Button>
        </form>
      </div>
    </div>
  );
}
