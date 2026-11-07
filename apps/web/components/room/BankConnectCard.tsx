"use client";
import { useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { IconBolt, IconLock } from "@/components/icons";
import { Button, Card, Chip, Spinner, type Tone } from "@/components/ui";
import { requestBankSync } from "@/lib/data/actions";
import { useBankConnections } from "@/lib/data/hooks";
import { relTime } from "@/lib/format";
import { checkWorker, useWorkerStatus, workerPost } from "@/lib/worker";
import type { BankConnection } from "@/lib/types";

/** Mounts only after a link token exists, opens Plaid Link as soon as it is ready. */
function PlaidOpener({ token, onPublicToken, onExit }: { token: string; onPublicToken: (t: string) => void; onExit: () => void }) {
  const { open, ready } = usePlaidLink({ token, onSuccess: (publicToken) => (publicToken ? onPublicToken(publicToken) : onExit()), onExit });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}

const STATUS: Record<BankConnection["status"], { tone: Tone; label: string }> = {
  linking: { tone: "info", label: "Linking" },
  syncing: { tone: "brand", label: "Syncing" },
  ok: { tone: "good", label: "Connected" },
  error: { tone: "risk", label: "Error" },
};

export function BankConnectCard({ householdId }: { householdId: string }) {
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
    <Card className="p-4" aria-labelledby="bank-h" role="region">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-strong"><IconLock size={18} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="bank-h" className="font-display text-[1.05rem] font-semibold leading-tight">Connect a bank</h2>
            <Chip tone="neutral">Plaid Sandbox</Chip>
          </div>
          <p className="mt-0.5 text-[0.8rem] leading-snug text-ink-2">Pull real bank-API data into this room. Agents check it and the forecast updates for everyone.</p>
        </div>
      </div>

      {offline ? (
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[0.82rem] text-ink-2" role="status">Bank connection is offline. The agent worker isn&apos;t reachable right now.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={startLink} disabled={disabled}>{busy === "link" ? <Spinner /> : null} Connect a bank</Button>
            <Button variant="secondary" onClick={quick} disabled={disabled}>{busy === "quick" ? <Spinner /> : <IconBolt size={16} />} Quick connect (sandbox)</Button>
          </div>
          <p className="mt-2 text-[0.76rem] text-ink-3">Sandbox login in Plaid Link: <code className="rounded bg-surface-2 px-1 font-mono">user_good</code> / <code className="rounded bg-surface-2 px-1 font-mono">pass_good</code></p>
        </>
      )}
      {offline ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled>Connect a bank</Button>
          <Button variant="secondary" disabled>Quick connect (sandbox)</Button>
        </div>
      ) : null}
      {err ? <p role="alert" className="mt-2 text-[0.82rem] text-risk">{err}</p> : null}

      {conns.length ? (
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
          {conns.map((b) => {
            const s = STATUS[b.status];
            return (
              <li key={b.item_id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{b.institution_name}</p>
                  <p className="num text-[0.74rem] text-ink-3">
                    {b.accounts_count} accounts · {b.txns_count.toLocaleString()} transactions{b.last_synced_at ? ` · synced ${relTime(b.last_synced_at)}` : ""}
                  </p>
                  {b.error ? <p className="text-[0.74rem] text-risk">{b.error}</p> : null}
                </div>
                <Chip tone={s.tone}>{b.status === "syncing" || b.status === "linking" ? <Spinner size={10} /> : null}{s.label}</Chip>
                <Button size="sm" variant="ghost" onClick={() => void requestBankSync(householdId)} disabled={b.status === "syncing" || b.status === "linking"}>Sync</Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {token ? <PlaidOpener token={token} onPublicToken={(t) => void exchange(t)} onExit={() => { setToken(null); setBusy(null); }} /> : null}
    </Card>
  );
}
