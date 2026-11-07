"use client";
import { useId, useState } from "react";
import { IconBot } from "@/components/icons";
import { Button, Spinner, inputCls, labelCls } from "@/components/ui";
import { createProposal } from "@/lib/data/actions";
import { useLocalIdentity } from "@/lib/data/identity";
import type { ProposalDetails } from "@/lib/types";

const num = (s: string): number | undefined => {
  const n = Number(s.replace(/[$,%\s,]/g, ""));
  return s.trim() && Number.isFinite(n) ? n : undefined;
};

/** "New proposal": calls `create_proposal`, which also queues the agent's affordability check. */
export function NewProposalForm({ householdId, onDone, onCancel }: { householdId: string; onDone?: (id: string) => void; onCancel?: () => void }) {
  const uid = useId();
  const ident = useLocalIdentity();
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [down, setDown] = useState("");
  const [term, setTerm] = useState("");
  const [rate, setRate] = useState("");
  const [days, setDays] = useState("5");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const amt = num(amount);
    if (!title.trim() || amt === undefined || amt <= 0) {
      setErr("Add a title and an amount greater than zero.");
      return;
    }
    const details: ProposalDetails = {};
    const d = num(down);
    const t = num(term);
    const r = num(rate);
    if (d !== undefined) details.down_pct = d;
    if (t !== undefined) details.term_months = t;
    if (r !== undefined) details.rate_pct = r;
    setErr(null);
    setBusy(true);
    try {
      const id = await createProposal({ householdId, title: title.trim(), amount: amt, details, closesInDays: Number(days) || 5, authorName: ident.name ?? "Someone" });
      setTitle("");
      setAmount("");
      setDown("");
      setTerm("");
      setRate("");
      onDone?.(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create the proposal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="rounded-lg border border-line-strong bg-surface-2 p-3.5"
      aria-label="New proposal"
    >
      <div className="grid gap-3 sm:grid-cols-6">
        <div className="sm:col-span-4">
          <label htmlFor={`${uid}-t`} className={labelCls}>What are you proposing?</label>
          <input id={`${uid}-t`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Buy a used minivan" maxLength={80} className={inputCls} required />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-a`} className={labelCls}>Amount (USD)</label>
          <input id={`${uid}-a`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="35,000" className={inputCls} required />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-d`} className={labelCls}>Down payment % <span className="text-ink-3">(optional)</span></label>
          <input id={`${uid}-d`} value={down} onChange={(e) => setDown(e.target.value)} inputMode="decimal" placeholder="20" className={inputCls} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-m`} className={labelCls}>Term, months <span className="text-ink-3">(optional)</span></label>
          <input id={`${uid}-m`} value={term} onChange={(e) => setTerm(e.target.value)} inputMode="numeric" placeholder="60" className={inputCls} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-r`} className={labelCls}>Rate % <span className="text-ink-3">(optional)</span></label>
          <input id={`${uid}-r`} value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" placeholder="6.2" className={inputCls} />
        </div>
        <div className="sm:col-span-3">
          <label htmlFor={`${uid}-w`} className={labelCls}>Voting stays open for</label>
          <select id={`${uid}-w`} value={days} onChange={(e) => setDays(e.target.value)} className={`${inputCls} appearance-auto`}>
            {[1, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d} {d === 1 ? "day" : "days"}</option>)}
          </select>
        </div>
      </div>
      <p className="mt-2.5 flex items-start gap-1.5 text-[0.76rem] leading-snug text-ink-3"><IconBot size={14} className="mt-px shrink-0" /> An agent checks affordability against your real accounts and attaches its verdict for everyone to see.</p>
      {err ? <p role="alert" className="mt-2 text-[0.8rem] text-risk">{err}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button type="submit" variant="dark" disabled={busy}>{busy ? <Spinner size={14} /> : null} Create proposal</Button>
        {onCancel ? <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button> : null}
      </div>
    </form>
  );
}
