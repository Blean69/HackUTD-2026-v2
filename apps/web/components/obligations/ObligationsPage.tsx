"use client";
import { useMemo, type ComponentType, type ReactNode } from "react";
import { IconBank, IconCap, IconFile, IconLandmark, IconRepeat, IconShield, IconTrend } from "@/components/icons";
import { Card, Chip, Empty, IconTile, PageHeader, Panel, TableScroll, type Tone } from "@/components/ui";
import { useRoomFinance } from "@/lib/data/finance-hooks";
import { fixedMonthly, upcomingObligations } from "@/lib/finance";
import { cx, longDate, usd } from "@/lib/format";
import type { Obligation } from "@/lib/types";

const KIND: Record<Obligation["kind"], { label: string; Icon: ComponentType<{ size?: number }> }> = {
  loan: { label: "Loan", Icon: IconBank },
  bill: { label: "Bill", Icon: IconFile },
  subscription: { label: "Subscription", Icon: IconRepeat },
  tuition: { label: "Tuition", Icon: IconCap },
  insurance: { label: "Insurance", Icon: IconShield },
  tax: { label: "Tax", Icon: IconLandmark },
};

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[0.76rem] font-medium text-ink-2">{label}</p>
      <p className="num mt-0.5 text-[1.3rem] font-semibold leading-tight tracking-tight">{value}</p>
      {sub ? <div className="mt-0.5 text-[0.74rem] leading-snug text-ink-3">{sub}</div> : null}
    </Card>
  );
}

function lowTone(balance: number): Tone {
  return balance < 0 ? "risk" : balance < 3000 ? "watch" : "good";
}

export function ObligationsPage({ householdId }: { householdId: string }) {
  const fin = useRoomFinance(householdId);
  const { obligations, accounts, today, forecast } = fin;

  const schedule = useMemo(() => {
    const byId = new Map(obligations.map((o) => [o.id, o]));
    const acct = new Map(accounts.map((a) => [a.id, a.nickname]));
    return upcomingObligations(obligations, today, 100).map((u) => {
      const o = byId.get(u.id);
      return { ...u, dueDay: o?.due_day ?? 0, paidFrom: o ? acct.get(o.account_id) : undefined };
    });
  }, [obligations, accounts, today]);

  const monthly = fixedMonthly(obligations);
  const due7 = schedule.filter((s) => s.days <= 7);
  const due30 = schedule.filter((s) => s.days <= 30);
  const sum = (rows: { amount: number }[]) => rows.reduce((t, r) => t + r.amount, 0);
  const kinds = useMemo(() => {
    const counts = new Map<Obligation["kind"], number>();
    for (const o of obligations) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [obligations]);

  const low = forecast.low_point;
  const lowT = low ? lowTone(low.balance) : "neutral";

  return (
    <div>
      <PageHeader title="Obligations" sub="Everything the household owes on a schedule, and when it is next due" />

      {!obligations.length ? (
        <Empty title="No obligations on file">Bills, loan payments, subscriptions and insurance appear here once they are added.</Empty>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Monthly total (est.)" value={usd(monthly)} sub="Taxes spread over 12 months" />
            <Stat label="Due in 7 days" value={usd(sum(due7))} sub={`${due7.length} ${due7.length === 1 ? "payment" : "payments"}`} />
            <Stat label="Due in 30 days" value={usd(sum(due30))} sub={`${due30.length} ${due30.length === 1 ? "payment" : "payments"}`} />
            <Stat
              label="Obligations"
              value={obligations.length}
              sub={
                <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                  {kinds.map(([k, n]) => <span key={k} className="num whitespace-nowrap">{n} {KIND[k].label.toLowerCase()}</span>)}
                </span>
              }
            />
          </div>

          {low ? (
            <Card className="flex items-start gap-3 p-4">
              <IconTile tone={lowT} size={36}><IconTrend size={18} /></IconTile>
              <div className="min-w-0">
                <h2 className="text-[0.95rem] font-semibold leading-tight">Cash forecast low point</h2>
                <p className="mt-0.5 text-[0.86rem] leading-snug text-ink-2">
                  Projected cash dips to <span className={cx("num font-semibold", lowT === "risk" ? "text-risk" : lowT === "watch" ? "text-watch" : "text-good")}>{usd(low.balance)}</span> on{" "}
                  <span className="font-medium text-ink">{longDate(low.date)}</span>
                  {lowT === "risk" ? ", below zero. Move money or delay a payment before then." : lowT === "watch" ? ", a thin cushion after scheduled payments." : ", comfortably above zero after scheduled payments."}
                </p>
                <p className="mt-1 text-[0.74rem] text-ink-3">From the {forecast.points.length}-day cash forecast (est.).</p>
              </div>
            </Card>
          ) : null}

          <Panel id="schedule" title="Payment schedule" sub="Sorted by next due date">
            <TableScroll>
              <table className="tbl min-w-[40rem]">
                <thead>
                  <tr>
                    <th scope="col">Obligation</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="r">Amount</th>
                    <th scope="col">Due day</th>
                    <th scope="col">Next due</th>
                    <th scope="col">Paid from</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((s) => {
                    const k = KIND[s.kind];
                    const urgent = s.days <= 3;
                    return (
                      <tr key={s.id}>
                        <td className="font-medium">{s.name}</td>
                        <td>
                          <Chip><k.Icon size={12} />{k.label}</Chip>
                        </td>
                        <td className="r num whitespace-nowrap font-semibold">{usd(s.amount, { cents: s.amount % 1 !== 0 })}</td>
                        <td className="whitespace-nowrap text-ink-2">{s.dueDay ? `${ordinal(s.dueDay)} of month` : "n/a"}</td>
                        <td className={cx("whitespace-nowrap", urgent && "text-watch")}>
                          <span className={cx("num", urgent && "font-semibold")}>{longDate(s.due)}</span>
                          <span className={cx("ml-1.5 text-[0.76rem]", urgent ? "text-watch" : "text-ink-3")}>{s.when}</span>
                        </td>
                        <td className="whitespace-nowrap text-ink-2">{s.paidFrom ?? <span className="text-ink-3">n/a</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </Panel>
        </div>
      )}
    </div>
  );
}
