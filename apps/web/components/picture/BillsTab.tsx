"use client";
import { useMemo } from "react";
import { Empty, Notice, Skeleton, StatCard, TableScroll } from "@/components/ui";
import { useToday } from "@/lib/data/finance-hooks";
import { useAccounts, useForecast, useObligations, useRoomTables } from "@/lib/data/hooks";
import { fixedMonthly, upcomingObligations } from "@/lib/finance";
import { cx, longDate, usd } from "@/lib/format";

const sum = (rows: readonly { amount: number }[]) => rows.reduce((t, r) => t + r.amount, 0);

/** The whole bill schedule, the cash low point, and three totals in one line. */
export function BillsTab({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["obligation", "forecast_point"]);
  const obligations = useObligations(householdId);
  const accounts = useAccounts(householdId);
  const forecast = useForecast(householdId);
  const today = useToday();

  const schedule = useMemo(() => {
    const acct = new Map(accounts.map((a) => [a.id, a.nickname]));
    const byId = new Map(obligations.map((o) => [o.id, o]));
    return upcomingObligations(obligations, today, 100).map((u) => ({ ...u, paidFrom: acct.get(byId.get(u.id)?.account_id ?? "") }));
  }, [obligations, accounts, today]);

  if (!ready) return <Skeleton className="h-72 !rounded-lg" />;
  if (!obligations.length) return <Empty title="No bills on file">Loans, bills, subscriptions and insurance appear here once they are added.</Empty>;

  const low = forecast.low_point;
  const due7 = sum(schedule.filter((s) => s.days <= 7));
  const due30 = sum(schedule.filter((s) => s.days <= 30));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Bills a month" value={usd(fixedMonthly(obligations))} sub={`${obligations.length} on file`} />
        <StatCard label="Due this week" value={usd(due7)} tone={due7 > 0 ? "watch" : undefined} />
        <StatCard label="Next 30 days" value={usd(due30)} />
      </div>
      {low ? (
        <Notice tone={low.balance < 0 ? "error" : low.balance < 3000 ? "warn" : "good"}>
          Cash is projected to dip to <span className="num font-semibold">{usd(low.balance)}</span> on <span className="font-semibold">{longDate(low.date)}</span>
          {low.balance < 0 ? ". Move money or delay a payment before then." : low.balance < 3000 ? ", a thin cushion after scheduled payments." : ", comfortably above zero."}
        </Notice>
      ) : null}
      <div className="card overflow-hidden">
        <TableScroll>
          <table className="tbl">
            <caption className="sr-only">Bills by next due date</caption>
            <thead><tr>
              <th scope="col" className="!pl-4">Bill</th>
              <th scope="col" className="r">Amount</th>
              <th scope="col">Next due</th>
              <th scope="col" className="hidden !pr-4 sm:table-cell">Paid from</th>
            </tr></thead>
            <tbody>
              {schedule.map((s) => (
                <tr key={s.id}>
                  <td className="!pl-4 font-medium">{s.name}<span className="block text-caption font-normal capitalize text-ink-3">{s.kind}</span></td>
                  <td className="r num whitespace-nowrap font-semibold">{usd(s.amount, { cents: s.amount % 1 !== 0 })}</td>
                  <td className="whitespace-nowrap">
                    <span className="num">{longDate(s.due)}</span>
                    <span className={cx("block text-caption", s.days <= 3 ? "font-medium text-watch" : "text-ink-3")}>{s.when}</span>
                  </td>
                  <td className="hidden whitespace-nowrap !pr-4 text-ink-2 sm:table-cell">{s.paidFrom ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </div>
  );
}
