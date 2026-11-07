"use client";
import { Card, Chip, SectionTitle } from "@/components/ui";
import { IconChevronDown } from "@/components/icons";
import { ACCOUNT_GROUPS, cx, longDate, pct, usd } from "@/lib/format";
import type { NetWorth } from "@/lib/data/hooks";
import type { Account } from "@/lib/types";

function detail(a: Account): string {
  const bits: string[] = [a.institution];
  if (a.type === "credit_card" && a.credit_limit) bits.push(`${Math.round((a.balance / a.credit_limit) * 100)}% of ${usd(a.credit_limit)} limit`);
  if (a.rate_pct !== undefined && a.type !== "checking") bits.push(`${a.rate_pct}% ${["savings", "cd"].includes(a.type) ? "APY" : "APR"}`);
  if (a.monthly_payment) bits.push(`${usd(a.monthly_payment)}/mo`);
  if (a.maturity_date) bits.push(`matures ${longDate(a.maturity_date)}`);
  return bits.join(" · ");
}

export function NetWorthCard({ nw, name, property = 0 }: { nw: NetWorth; name?: string; property?: number }) {
  const total = nw.assets + nw.liabilities || 1;
  return (
    <Card className="overflow-hidden p-5">
      <p className="text-[0.8rem] font-medium uppercase tracking-wide text-ink-2">Net worth{name ? ` · ${name}` : ""}</p>
      <p className="num mt-1 font-display text-[2.6rem] font-bold leading-none tracking-tight sm:text-5xl">{usd(nw.net)}</p>
      <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-risk-soft" role="img" aria-label={`Assets ${usd(nw.assets)}, debts ${usd(nw.liabilities)}`}>
        <div className="bg-good" style={{ width: `${(nw.assets / total) * 100}%` }} />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-ink-2">Owns</dt>
          <dd className="num font-semibold text-good">{usd(nw.assets)}</dd>
          {property > 0 ? <dd className="num text-[0.72rem] text-ink-3">incl. {usd(property, { compact: true })} home &amp; vehicle</dd> : null}
        </div>
        <div className="text-right">
          <dt className="text-ink-2">Owes</dt>
          <dd className="num font-semibold text-risk">{usd(nw.liabilities)}</dd>
        </div>
      </dl>
    </Card>
  );
}

export function AccountsPanel({ accounts }: { accounts: readonly Account[] }) {
  return (
    <section aria-labelledby="accounts-h">
      <SectionTitle id="accounts-h" title="Accounts" sub={`${accounts.length} accounts across ${new Set(accounts.map((a) => a.institution)).size} institutions`} />
      <div className="space-y-2.5">
        {ACCOUNT_GROUPS.map((g) => {
          const rows = accounts.filter((a) => g.types.includes(a.type));
          if (!rows.length) return null;
          const sum = rows.reduce((s, a) => s + a.balance, 0);
          return (
            <details key={g.key} open className="group rounded-2xl border border-line bg-surface shadow-card">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="font-display text-[1rem] font-semibold">{g.label}</span>
                <Chip>{rows.length}</Chip>
                <span className={cx("num ml-auto text-sm font-semibold", g.liability ? "text-risk" : "text-ink")}>{g.liability ? `-${usd(sum)}` : usd(sum)}</span>
                <IconChevronDown size={16} className="text-ink-3 transition-transform group-open:rotate-180" />
              </summary>
              <ul className="divide-y divide-line border-t border-line">
                {rows.map((a) => (
                  <li key={a.id} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="flex min-w-0 items-center gap-1.5 font-medium"><span className="truncate">{a.nickname}</span>{a.source === "plaid" ? <Chip tone="info" title="Synced from Plaid Sandbox">from Plaid</Chip> : null}</p>
                      <p className={cx("num shrink-0 font-semibold", g.liability && "text-risk")}>{g.liability ? `-${usd(a.balance)}` : usd(a.balance, { cents: a.type === "checking" })}</p>
                    </div>
                    <p className="mt-0.5 text-[0.78rem] leading-snug text-ink-2">{detail(a)}</p>
                    {a.type === "credit_card" && a.credit_limit ? (
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${pct((a.balance / a.credit_limit) * 100)} utilized`}>
                        <div className={cx("h-full", a.balance / a.credit_limit > 0.5 ? "bg-risk" : a.balance / a.credit_limit > 0.3 ? "bg-watch" : "bg-good")} style={{ width: `${Math.min(100, (a.balance / a.credit_limit) * 100)}%` }} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </section>
  );
}
