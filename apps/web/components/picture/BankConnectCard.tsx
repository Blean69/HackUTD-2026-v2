"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { IconBank, IconBolt } from "@/components/icons";
import { Button, Chip, ErrorNote, Panel, Spinner, type Tone } from "@/components/ui";
import { requestBankSync } from "@/lib/data/actions";
import { useBankConnections } from "@/lib/data/hooks";
import { relTime } from "@/lib/format";
import type { BankConnection } from "@/lib/types";
import { checkWorker, useWorkerStatus, workerPost } from "@/lib/worker";

/** Plaid Link's script only loads once someone taps "Link with Plaid". */
const PlaidOpener = dynamic(() => import("./PlaidOpener").then((m) => m.PlaidOpener), { ssr: false });

const STATUS: Record<BankConnection["status"], { tone: Tone; label: string }> = {
  linking: { tone: "info", label: "Linking" },
  selecting: { tone: "info", label: "Choose accounts" },
  syncing: { tone: "brand", label: "Syncing" },
  ok: { tone: "good", label: "Connected" },
  error: { tone: "risk", label: "Error" },
};

export function BankConnectCard({ householdId, className }: { householdId: string; className?: string }) {
  const worker = useWorkerStatus();
  const conns = useBankConnections(householdId);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"link" | "quick" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    checkWorker();
  }, []);

  const offline = worker === "down";
  const disabled = offline || worker === "checking" || busy !== null;

  async function startLink() {
    setErr(null);
    setBusy("link");
    try {
      const r = await workerPost<{ link_token: string }>("/plaid/link_token", { household_id: householdId });
      setToken(r.link_token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't start Plaid Link");
      setBusy(null);
    }
  }

  async function exchange(publicToken: string) {
    setToken(null);
    try {
      await workerPost("/plaid/exchange", { household_id: householdId, public_token: publicToken });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't finish connecting");
    } finally {
      setBusy(null);
    }
  }

  async function quick() {
    setErr(null);
    setBusy("quick");
    try {
      await workerPost("/plaid/sandbox_connect", { household_id: householdId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Quick connect failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      id="bank-connect"
      className={className}
      title={<><IconBank size={17} className="text-brand" />Connect a bank</>}
      sub="Sandbox data only. Everyone in the room sees the new accounts."
    >
      {offline ? (
        <p className="mb-3 rounded-md bg-surface-2 px-3 py-2 text-[0.82rem] text-ink-2" role="status">
          Bank connection is offline. The agent worker isn&apos;t reachable right now.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void startLink()} disabled={disabled}>
          {busy === "link" ? <Spinner /> : null}
          Link with Plaid
        </Button>
        <Button variant="secondary" onClick={() => void quick()} disabled={disabled}>
          {busy === "quick" ? <Spinner /> : <IconBolt size={16} />}
          Use the demo bank
        </Button>
      </div>
      {!offline ? (
        <p className="mt-2 text-[0.78rem] text-ink-3">
          Plaid Link sandbox login: <code className="rounded bg-surface-2 px-1 font-mono">user_good</code> / <code className="rounded bg-surface-2 px-1 font-mono">pass_good</code>
        </p>
      ) : null}
      {err ? <ErrorNote className="mt-2">{err}</ErrorNote> : null}

      {conns.length ? (
        <ul className="mt-3 divide-y divide-line rounded-md border border-line" aria-label="Connected banks">
          {conns.map((b) => {
            const s = STATUS[b.status];
            const working = b.status === "syncing" || b.status === "linking";
            return (
              <li key={b.item_id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-[0.88rem] font-medium">{b.institution_name}</p>
                  <p className="num text-[0.76rem] text-ink-3">
                    {b.accounts_count} accounts · {b.txns_count.toLocaleString()} transactions{b.last_synced_at ? ` · synced ${relTime(b.last_synced_at)}` : ""}
                  </p>
                  {b.error ? <p className="text-[0.76rem] text-risk">{b.error}</p> : null}
                </div>
                <Chip tone={s.tone}>
                  {working ? <Spinner size={10} /> : null}
                  {s.label}
                </Chip>
                <Button size="sm" variant="secondary" onClick={() => void requestBankSync(householdId)} disabled={working} aria-label={`Sync ${b.institution_name}`}>
                  Sync
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {token ? <PlaidOpener token={token} onPublicToken={(t) => void exchange(t)} onExit={() => { setToken(null); setBusy(null); }} /> : null}
    </Panel>
  );
}
