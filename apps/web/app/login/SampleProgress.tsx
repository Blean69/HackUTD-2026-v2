"use client";
import { useEffect, useId, useMemo, useRef } from "react";
import { IconAlert, IconCheck } from "@/components/icons";
import { CountUp, prefersReducedMotion } from "@/components/motion";
import { Avatar, Button, Notice, Progress } from "@/components/ui";
import { useAccounts, useRoomTables, useRows, useTxns } from "@/lib/data/hooks";
import {
  SAMPLE_PHASES, sampleHouseholdName, splitProfileName, profileFirstName, profilePossessive, useAccountOptions, useOnboardingBank, type SamplePhase,
} from "@/lib/data/onboarding";
import { cx } from "@/lib/format";
import { checkWorker, useWorkerStatus } from "@/lib/worker";
import type { SampleRun } from "./useSampleSetup";

const LABELS: Record<SamplePhase, string> = {
  household: "Create the household",
  bank: "Connect to the sandbox bank",
  accounts: "Choose the accounts",
  sync: "Import accounts and transactions",
  finish: "Save the details and open the dashboard",
};

type StepState = "done" | "active" | "pending" | "error";

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span className="motion-pop mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-good-soft text-good">
        <IconCheck size={12} strokeWidth={2.8} />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-risk-soft text-risk">
        <IconAlert size={12} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cx("mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2", state === "active" ? "border-brand" : "border-line-strong")}>
      {state === "active" ? <span className="anim-blink h-1.5 w-1.5 rounded-full bg-brand" /> : null}
    </span>
  );
}

/**
 * The tapped customer's card turns into this while the automatic setup runs: the steps in order, the counts ticking up as
 * rows arrive, and Retry / Cancel when something is slow or wrong. Never a bare spinner.
 */
export function SampleProgress({ run, onRetry, onCancel }: { run: SampleRun; onRetry: () => void; onCancel: () => void }) {
  const { profile, householdId, phase, stalled, error, done } = run;
  const hid = householdId ?? "";
  const headingId = useId();
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Live data for this household. The transactions table is not part of the default room tables, so ask for it.
  useRoomTables(hid, hid ? ["txn"] : []);
  const bank = useOnboardingBank(householdId);
  const offered = useAccountOptions(householdId);
  const accounts = useAccounts(hid);
  const txns = useTxns(hid);
  const events = useRows("trace_event");
  const worker = useWorkerStatus();

  const arrived = useMemo(() => accounts.filter((a) => a.source === "plaid" || a.id.startsWith("acct_plaid_")).length, [accounts]);
  const imported = useMemo(() => txns.filter((t) => t.source === "plaid" || t.id.startsWith("txn_plaid_")).length, [txns]);
  const txnCount = Math.max(bank?.txns_count ?? 0, imported);
  const want = offered.length || profile.accounts.length;
  const accountCount = Math.min(want, Math.max(bank?.accounts_count ?? 0, arrived));
  const latest = useMemo(() => {
    let best: (typeof events)[number] | undefined;
    for (const e of events) {
      if (e.household_id !== hid || e.workflow !== "plaid_sync") continue;
      if (!best || e.ts > best.ts || (e.ts === best.ts && e.seq > best.seq)) best = e;
    }
    return best?.title;
  }, [events, hid]);

  // Bring the panel into view and announce it, once, when it appears.
  useEffect(() => {
    box.current?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    heading.current?.focus({ preventScroll: true });
  }, []);
  // A slow or failed run is when "is the connector even up?" matters.
  useEffect(() => {
    if (stalled || error) checkWorker(true);
  }, [stalled, error]);

  const current = SAMPLE_PHASES.indexOf(phase);
  const state = (i: number): StepState => (done || i < current ? "done" : i === current ? (error ? "error" : "active") : "pending");
  const syncShare = want ? 0.5 * Math.min(1, accountCount / want) + 0.5 * Math.min(1, txnCount / Math.max(1, profile.txn_count || 200)) : 0;
  const fraction = done ? 1 : [0.04, 0.14, 0.28, 0.3 + 0.6 * syncShare, 0.96][current] ?? 0;
  const first = profileFirstName(profile);
  const [, about] = splitProfileName(profile.display_name);
  const offline = error?.kind === "offline" || (stalled && worker === "down");

  const detail = (i: number): React.ReactNode => {
    const key = SAMPLE_PHASES[i];
    const s = state(i);
    if (s === "pending") return null;
    if (s === "error") return offline ? "No answer from the bank connector" : "Stopped here";
    if (key === "household") return sampleHouseholdName(profile);
    if (key === "bank") return s === "done" ? `${offered.length || want} accounts found${bank?.institution_name ? ` at ${bank.institution_name}` : ""}` : "Contacting the bank…";
    if (key === "accounts") return s === "done" ? `All ${offered.length || want} selected` : `Selecting all ${want}`;
    if (key === "sync") {
      return (
        <>
          <CountUp value={accountCount} /> of {want} {want === 1 ? "account" : "accounts"} · <CountUp value={txnCount} /> transactions
        </>
      );
    }
    return s === "done" ? "Opening the dashboard…" : null;
  };

  return (
    <section ref={box} aria-labelledby={headingId} aria-busy={!error} className="motion-rise rounded-lg border border-brand bg-brand-soft/45 p-4">
      <div className="flex items-start gap-3">
        <Avatar name={first} size={36} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} ref={heading} tabIndex={-1} className="text-lead font-semibold leading-tight outline-none">
            {done ? `Opening ${profilePossessive(profile)} dashboard…` : error ? `Setup of ${profilePossessive(profile)} accounts paused` : `Setting up ${profilePossessive(profile)} accounts…`}
          </h3>
          {about ? <p className="mt-0.5 text-label leading-snug text-ink-2">{about}</p> : null}
        </div>
      </div>

      <Progress value={fraction * 100} label="Setup progress" className="mt-3.5" />

      <ol className="mt-3.5 space-y-2.5" aria-label="Setup steps">
        {SAMPLE_PHASES.map((key, i) => {
          const s = state(i);
          const text = detail(i);
          return (
            <li key={key} className="flex items-start gap-3" aria-current={s === "active" ? "step" : undefined}>
              <StepIcon state={s} />
              <div className="min-w-0 flex-1">
                <p className={cx("text-body leading-tight", s === "active" ? "font-semibold text-ink" : s === "done" ? "text-ink" : s === "error" ? "font-semibold text-risk" : "text-ink-3")}>{LABELS[key]}</p>
                {text ? <p className="num mt-0.5 text-caption text-ink-3">{text}</p> : null}
                {key === "sync" && s === "active" && latest ? <p className="mt-0.5 line-clamp-2 text-caption leading-snug text-ink-3">{latest}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>

      {error ? (
        <Notice tone="error" className="mt-4">
          {error.kind === "offline"
            ? "We couldn't reach the bank connector. It may be offline or still waking up. Retry once it is back, or cancel."
            : error.message}
        </Notice>
      ) : stalled ? (
        <Notice tone="warn" className="mt-4">
          {offline
            ? "The bank connector isn't answering. We'll keep waiting. Retry once it is back, or cancel."
            : "This is taking longer than usual. We're still waiting on the bank. You can keep waiting, retry or cancel."}
        </Notice>
      ) : null}

      {!done ? (
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          {error || stalled ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {error ? "Setup paused" : done ? "Done. Opening the dashboard" : `${LABELS[phase]}`}
      </p>
    </section>
  );
}
