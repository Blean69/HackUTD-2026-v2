"use client";
import { useState, type ReactNode } from "react";
import { Chip, Empty, PageHeader, Progress, Skeleton, TableScroll, Tabs, type Tone } from "@/components/ui";
import { useAccounts, useDataReady } from "@/lib/data/hooks";
import { ACCOUNT_GROUPS, LIABILITY_TYPES, cx, longDate, pct, usd } from "@/lib/format";
import type { Account } from "@/lib/types";
import { BankConnectCard } from "./BankConnectCard";
import { BillsTab } from "./BillsTab";
import { ActivityTab } from "./ActivityTab";
import { PICTURE_TABS, type PictureTab } from "./tabs";

function utilTone(u: number): Tone {
  return u > 50 ? "risk" : u > 30 ? "watch" : "good";
}

/** Rate, monthly payment, maturity, card utilization: one short line, or nothing. */
function Details({ a }: { a: Account }) {
  const bits: ReactNode[] = [];
  if (a.rate_pct !== undefined && a.type !== "checking") {
    bits.push(<span key="rate" className="num">{a.rate_pct}% {a.type === "savings" || a.type === "cd" || a.type === "ira" ? "APY" : "APR"}</span>);
  }
  if (a.monthly_payment) bits.push(<span key="pay" className="num">{usd(a.monthly_payment)}/mo</span>);
  if (a.maturity_date) bits.push(<span key="mat">matures {longDate(a.maturity_date)}</span>);
  const util = a.type === "credit_card" && a.credit_limit ? (a.balance / a.credit_limit) * 100 : null;
  if (!bits.length && util === null) return null;
  return (
    <div className="space-y-1 text-label text-ink-2">
      {bits.length ? <p className="flex flex-wrap gap-x-2 gap-y-0.5">{bits}</p> : null}
      {util !== null && a.credit_limit ? (
        <div className="min-w-32">
          <p className="num whitespace-nowrap">{pct(util)} of {usd(a.credit_limit)} limit</p>
          <Progress value={util} tone={utilTone(util)} label={`${a.nickname} credit utilization`} className="mt-1" />
        </div>
      ) : null}
    </div>
  );
}

function AccountsTab({ householdId }: { householdId: string }) {
  const ready = useDataReady();
  const accounts = useAccounts(householdId);
  const allPlaid = accounts.length > 0 && accounts.every((a) => a.source === "plaid");
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 xl:col-start-1 xl:row-start-1">
        {!ready ? (
          <Skeleton className="h-72 !rounded-lg" />
        ) : !accounts.length ? (
          <Empty title="No accounts yet">Connect a bank and your accounts land here.</Empty>
        ) : (
          <div className="card overflow-hidden">
            {allPlaid ? <p className="border-b border-line px-4 py-2.5 text-label text-ink-2"><Chip tone="info">Plaid</Chip> <span className="ml-1">All accounts synced from Plaid Sandbox</span></p> : null}
            <TableScroll>
              <table className="tbl">
                <thead className="sr-only"><tr><th scope="col">Account</th><th scope="col">Balance</th></tr></thead>
                {ACCOUNT_GROUPS.map((g) => {
                  const rows = accounts.filter((a) => g.types.includes(a.type));
                  if (!rows.length) return null;
                  const sum = rows.reduce((s, a) => s + a.balance, 0);
                  return (
                    <tbody key={g.key} id={`group-${g.key}`} className="scroll-mt-20">
                      <tr className="bg-surface-2">
                        <th scope="rowgroup" className="!px-4 !py-2 !text-label !font-semibold !text-ink-2">
                          {g.label} <span className="num font-normal text-ink-3">{rows.length}</span>
                        </th>
                        <td className={cx("num r !py-2 !pr-4 font-semibold", g.liability && "text-risk")}>{g.liability ? usd(-sum) : usd(sum)}</td>
                      </tr>
                      {rows.map((a) => {
                        const liability = LIABILITY_TYPES.has(a.type);
                        return (
                          <tr key={a.id}>
                            <td className="!pl-4">
                              <div className="md:flex md:items-start md:justify-between md:gap-6">
                                <div className="min-w-0">
                                  <span className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-medium">{a.nickname}</span>
                                    {a.source === "plaid" && !allPlaid ? <Chip tone="info" title="Synced from Plaid Sandbox">Plaid</Chip> : null}
                                  </span>
                                  <span className="block text-caption text-ink-3">{a.institution}</span>
                                </div>
                                <div className="mt-1 md:mt-0 md:w-64 md:shrink-0"><Details a={a} /></div>
                              </div>
                            </td>
                            <td className={cx("num r !pr-4 whitespace-nowrap font-semibold", liability && "text-risk")}>
                              {liability ? usd(-a.balance) : usd(a.balance, { cents: a.type === "checking" })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  );
                })}
              </table>
            </TableScroll>
          </div>
        )}
      </div>
      <BankConnectCard householdId={householdId} className="xl:col-start-2 xl:row-start-1" />
    </div>
  );
}

/** One home for what the household has: accounts and the bank link, the bill schedule, and the latest activity. */
export function MyPicture({ householdId, initialTab = "accounts" }: { householdId: string; initialTab?: PictureTab }) {
  const [tab, setTab] = useState<PictureTab>(initialTab);
  const accounts = useAccounts(householdId);
  const institutions = new Set(accounts.map((a) => a.institution)).size;

  function pick(t: PictureTab) {
    setTab(t);
    try {
      const url = new URL(window.location.href);
      if (t === "accounts") url.searchParams.delete("tab");
      else url.searchParams.set("tab", t);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* the tab still switches */
    }
  }

  return (
    <div>
      <PageHeader
        title="My Picture"
        sub={accounts.length ? <span className="num">{accounts.length} accounts at {institutions} {institutions === 1 ? "institution" : "institutions"}</span> : undefined}
      />
      <Tabs label="My Picture sections" value={tab} onChange={pick} items={PICTURE_TABS} className="mb-4" />
      {tab === "accounts" ? <AccountsTab householdId={householdId} /> : tab === "bills" ? <BillsTab householdId={householdId} /> : <ActivityTab householdId={householdId} />}
    </div>
  );
}
