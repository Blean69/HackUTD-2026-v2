"use client";
import { useState } from "react";
import { CountUp } from "@/components/motion";
import { Panel, Progress, inputCls, labelCls, type Tone } from "@/components/ui";
import { cx, usd } from "@/lib/format";
import { minPayment, payoff } from "@/lib/loan";
import type { Member } from "@/lib/types";

const CHECKS = [
  "Open one card, charge small things, keep it under 30% of the limit",
  "Turn on autopay for at least the minimum on every loan and card",
  "Pull your free credit report and read it once a year",
  "Build a $1,000 starter emergency fund before anything fancy",
];
const years = (m: number) => `${Math.floor(m / 12)} yr${m % 12 ? ` ${m % 12} mo` : ""}`;
const num = (s: string) => Math.max(0, Number(s.replace(/[^\d.]/g, "")) || 0);

function Field({ id, label, value, set }: { id: string; label: string; value: string; set: (v: string) => void }) {
  return <div><label className={labelCls} htmlFor={id}>{label}</label><input id={id} className={inputCls} inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} /></div>;
}

function LoanPlanner() {
  const [bal, setBal] = useState("32000");
  const [apr, setApr] = useState("5.5");
  const [extra, setExtra] = useState(100);
  const b = num(bal), a = num(apr);
  const base = minPayment(b, a, 10);
  const slow = payoff(b, a, base);
  const fast = payoff(b, a, base + extra);
  const done = fast ? new Date(new Date().setMonth(new Date().getMonth() + fast.months)) : null;
  return (
    <Panel title="Student loan payoff" sub="See what a little extra each month does." className="col-span-12 lg:col-span-6" mascot="happy">
      <div className="grid grid-cols-2 gap-3">
        <Field id="loan-bal" label="Loan balance ($)" value={bal} set={setBal} />
        <Field id="loan-apr" label="Interest rate (%)" value={apr} set={setApr} />
      </div>
      <p className="mt-3 text-label text-ink-2">Standard 10-year payment: <span className="num font-semibold text-ink">{usd(base, { cents: true })}</span> a month</p>
      <label htmlFor="loan-extra" className={cx(labelCls, "mt-3")}>Extra each month: <span className="num font-semibold text-ink">{usd(extra)}</span></label>
      <input id="loan-extra" type="range" min={0} max={500} step={25} value={extra} onChange={(e) => setExtra(Number(e.target.value))} className="w-full accent-[var(--brand)]" />
      {slow && fast ? (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-surface-2 p-2.5"><p className="text-caption text-ink-3">Debt-free in</p><p className="figure text-lead">{years(fast.months)}</p></div>
          <div className="rounded-lg bg-good-soft p-2.5"><p className="text-caption text-ink-3">Interest saved</p><p className="figure text-lead text-good"><CountUp value={slow.interest - fast.interest} format={(n) => usd(n)} /></p></div>
          <div className="rounded-lg bg-surface-2 p-2.5"><p className="text-caption text-ink-3">Months sooner</p><p className="figure text-lead">{slow.months - fast.months}</p></div>
        </div>
      ) : <p className="mt-3 text-label text-risk">That payment does not cover the interest. Raise it.</p>}
      {done ? <p className="mt-2 text-caption text-ink-3">Paid off around {done.toLocaleDateString("en-US", { month: "long", year: "numeric" })}.</p> : null}
    </Panel>
  );
}

function FirstBudget({ member }: { member: Member }) {
  const gross = member.income_annual > 0 ? member.income_annual : 52000;
  const [pay, setPay] = useState(String(Math.round((gross * 0.78) / 12)));
  const [loan, setLoan] = useState("350");
  const take = num(pay);
  const rows: { label: string; pct: number; tone: Tone }[] = [{ label: "Needs: rent, food, bills", pct: 50, tone: "brand" }, { label: "Wants: fun and eating out", pct: 30, tone: "watch" }, { label: "Savings and extra debt", pct: 20, tone: "good" }];
  const loanShare = take ? (num(loan) / take) * 100 : 0;
  return (
    <Panel title="Your first real budget" sub="The 50/30/20 split on your take-home pay." className="col-span-12 lg:col-span-6">
      <div className="grid grid-cols-2 gap-3">
        <Field id="b-pay" label="Take-home per month ($)" value={pay} set={setPay} />
        <Field id="b-loan" label="Loan payment ($)" value={loan} set={setLoan} />
      </div>
      <ul className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <li key={r.label}>
            <div className="flex justify-between text-label"><span className="text-ink-2">{r.label}</span><span className="num font-semibold">{usd((take * r.pct) / 100)} <span className="font-normal text-ink-3">· {r.pct}%</span></span></div>
            <Progress value={r.pct} tone={r.tone} label={r.label} className="mt-1" height="h-2" />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-label text-ink-2">A safe rent is about <span className="num font-semibold text-ink">{usd((gross / 12) * 0.3)}</span> a month (30% of gross).</p>
      <p className={cx("mt-1 text-label", loanShare > 12 ? "text-watch" : "text-ink-2")}>Your loan takes <span className="num font-semibold">{loanShare.toFixed(0)}%</span> of take-home{loanShare > 12 ? ", on the heavy side. Try the extra-payment slider or income-driven repayment." : ", a comfortable share."}</p>
    </Panel>
  );
}

function CreditChecklist() {
  const [on, setOn] = useState<boolean[]>(CHECKS.map(() => false));
  const n = on.filter(Boolean).length;
  return (
    <Panel title="Build your credit" sub={`${n} of ${CHECKS.length} done`} className="col-span-12">
      <Progress value={(n / CHECKS.length) * 100} tone="good" label="Credit-building checklist" height="h-2" />
      <ul className="mt-3 grid gap-2 md:grid-cols-2">
        {CHECKS.map((c, i) => (
          <li key={c}>
            <label className="press flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-label">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={on[i]} onChange={() => setOn(on.map((v, j) => (j === i ? !v : v)))} />
              <span className={cx(on[i] && "text-ink-3 line-through")}>{c}</span>
            </label>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Teen mode (college grad): loans, a first budget and credit basics. Calculators only; nothing here is stored. */
export function TeenPlan({ member }: { member: Member }) {
  return (
    <div className="grid grid-cols-12 gap-3">
      <LoanPlanner />
      <FirstBudget member={member} />
      <CreditChecklist />
    </div>
  );
}
