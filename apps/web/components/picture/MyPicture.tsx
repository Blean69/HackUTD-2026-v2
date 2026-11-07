"use client";
import type { ReactNode } from "react";
import { Card, Chip, Delta, Empty, PageHeader, Panel, Progress, Skeleton, TableScroll, type Tone } from "@/components/ui";
import { useDataReady } from "@/lib/data/hooks";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { ACCOUNT_GROUPS, LIABILITY_TYPES, cx, longDate, pct, usd } from "@/lib/format";
import type { Account } from "@/lib/types";
import { BankConnectCard } from "./BankConnectCard";

function Stat({ label, value, sub, tone, className }: { label: string; value: string; sub?: ReactNode; tone?: "good" | "risk"; className?: string }) {
  return (
    <Card className={cx("px-4 py-3", className)}>
      <p className="text-[0.76rem] font-medium text-ink-2">{label}</p>
      <p className={cx("num mt-0.5 text-[1.3rem] font-semibold leading-tight tracking-tight sm:text-[1.2rem] lg:text-[1.35rem]", tone === "risk" && "text-risk")}>{value}</p>
      {sub ? <p className="mt-0.5 text-[0.74rem] leading-snug text-ink-3">{sub}</p> : null}
    </Card>
  );
}

function utilTone(u: number): Tone {
  return u > 50 ? "risk" : u > 30 ? "watch" : "good";
}

/** The "Details" cell: rate, limit + utilization, monthly payment, maturity. */
function Details({ a }: { a: Account }) {
  const bits: ReactNode[] = [];
  if (a.rate_pct !== undefined && a.type !== "checking") {
    bits.push(<span key="rate" className="num">{a.rate_pct}% {a.type === "savings" || a.type === "cd" || a.type === "ira" ? "APY" : "APR"}</span>);
  }
  if (a.monthly_payment) bits.push(<span key="pay" className="num">{usd(a.monthly_payment)}/mo</span>);
  if (a.maturity_date) bits.push(<span key="mat">Matures {longDate(a.maturity_date)}</span>);
  const util = a.type === "credit_card" && a.credit_limit ? (a.balance / a.credit_limit) * 100 : null;
  if (!bits.length && util === null) return <span className="text-ink-3">n/a</span>;
  return (
    <div className="space-y-1 text-ink-2">
      {bits.length ? <p className="flex flex-wrap gap-x-2 gap-y-0.5 whitespace-nowrap">{bits}</p> : null}
      {util !== null && a.credit_limit ? (
        <div className="min-w-36">
          <p className="num whitespace-nowrap text-[0.78rem]">{pct(util)} of {usd(a.credit_limit)} limit</p>
          <Progress value={util} tone={utilTone(util)} label={`${a.nickname} credit utilization`} className="mt-1" />
        </div>
      ) : null}
    </div>
  );
}

function AccountRow({ a, change }: { a: Account; change: number | null }) {
  const liability = LIABILITY_TYPES.has(a.type);
  return (
    <tr>
      <td>
        <span className="flex items-center gap-1.5">
          <span className="font-medium">{a.nickname}</span>
          {a.source === "plaid" ? <Chip tone="info" title="Synced from Plaid Sandbox">Plaid</Chip> : null}
        </span>
      </td>
      <td className="whitespace-nowrap text-ink-2">{a.institution}</td>
      <td className={cx("r num whitespace-nowrap font-semibold", liability && "text-risk")}>
        {liability ? usd(-a.balance) : usd(a.balance, { cents: a.type === "checking" })}
      </td>
      <td><Details a={a} /></td>
      <td className="r whitespace-nowrap">
        {change === null ? <span className="text-ink-3">n/a</span> : <Delta value={change} good={liability ? change <= 0 : change >= 0} />}
      </td>
    </tr>
  );
}

export function MyPicture({ householdId }: { householdId: string }) {
  const ready = useDataReady();
  const fin = useRoomFinance(householdId);
  const { accounts, nw, property, moM } = fin;
  const institutions = new Set(accounts.map((a) => a.institution)).size;

  return (
    <div>
      <PageHeader
        title="My Picture"
        sub="Every account in one place"
        right={accounts.length ? <p className="num text-[0.8rem] text-ink-3">{accounts.length} accounts · {institutions} {institutions === 1 ? "institution" : "institutions"}</p> : null}
      />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <BankConnectCard householdId={householdId} className="xl:col-start-2 xl:row-start-1" />

        <div className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat
              label="Net worth"
              value={usd(nw.net)}
              sub="Assets minus liabilities"
              tone={nw.net < 0 ? "risk" : undefined}
              className="col-span-2 sm:order-last sm:col-span-1"
            />
            <Stat label="Assets" value={usd(nw.assets)} sub={property > 0 ? `Incl. ${usd(property, { compact: true })} home & vehicle (est.)` : "Accounts you own"} />
            <Stat label="Liabilities" value={usd(-nw.liabilities)} sub="Loans, cards and mortgage" tone="risk" />
          </div>

          {!ready ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading accounts">
              <Skeleton className="h-40 !rounded-lg" />
              <Skeleton className="h-40 !rounded-lg" />
            </div>
          ) : !accounts.length ? (
            <Empty title="No accounts yet">Connect a bank to pull accounts into this room.</Empty>
          ) : (
            ACCOUNT_GROUPS.map((g) => {
              const rows = accounts.filter((a) => g.types.includes(a.type));
              if (!rows.length) return null;
              const sum = rows.reduce((s, a) => s + a.balance, 0);
              return (
                <Panel
                  key={g.key}
                  id={`group-${g.key}`}
                  title={<>{g.label}<Chip>{rows.length}</Chip></>}
                  right={<span className={cx("num text-[0.95rem] font-semibold", g.liability && "text-risk")}>{g.liability ? usd(-sum) : usd(sum)}</span>}
                >
                  <TableScroll>
                    <table className="tbl min-w-[40rem]">
                      <thead>
                        <tr>
                          <th scope="col">Account</th>
                          <th scope="col">Institution</th>
                          <th scope="col" className="r">Balance</th>
                          <th scope="col">Details</th>
                          <th scope="col" className="r">30-day change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((a) => <AccountRow key={a.id} a={a} change={moM(a)} />)}
                      </tbody>
                    </table>
                  </TableScroll>
                </Panel>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
