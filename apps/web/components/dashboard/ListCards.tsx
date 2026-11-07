"use client";
import Link from "next/link";
import {
  IconBank, IconCap, IconCar, IconCard, IconFile, IconHome, IconLandmark, IconPlane, IconPlus, IconRepeat, IconShield, IconTarget,
} from "@/components/icons";
import { Chip, Delta, IconTile, Panel, Progress, TableScroll, Avatar, type Tone } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { goalProgress } from "@/lib/finance";
import { ACCOUNT_GROUPS, LIABILITY_TYPES, cx, usd } from "@/lib/format";
import type { Account, AccountType, Goal, Obligation } from "@/lib/types";
import { ViewAll } from "./AnalysisCards";

const TYPE_LABEL: Record<AccountType, string> = {
  checking: "Checking", savings: "Savings", cd: "CD", ira: "IRA", auto_loan: "Auto loan", personal_loan: "Loan", credit_card: "Credit", mortgage: "Mortgage",
};
const GROUP_ORDER = ACCOUNT_GROUPS.flatMap((g) => g.types);

export function AccountsCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const rows = [...fin.accounts].sort((a, b) => GROUP_ORDER.indexOf(a.type) - GROUP_ORDER.indexOf(b.type) || b.balance - a.balance);
  const shown = rows.slice(0, 7);
  return (
    <Panel
      id="accounts-overview"
      title={<>Accounts Overview <span className="font-normal text-ink-3">({rows.length})</span></>}
      className={className}
      right={<ViewAll href={`/room/${householdId}/picture`}>View all</ViewAll>}
    >
      <TableScroll>
        <table className="tbl sm:min-w-[20rem]">
          <thead>
            <tr><th scope="col">Account</th><th scope="col" className="hidden sm:table-cell">Type</th><th scope="col" className="r">Balance</th><th scope="col" className="r">MoM Δ</th></tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const debt = LIABILITY_TYPES.has(a.type);
              const mom = fin.moM(a);
              const improving = mom === null ? true : debt ? mom < 0 : mom > 0;
              return (
                <tr key={a.id}>
                  <td className="max-w-[9rem] truncate font-medium"><span className="flex items-center gap-1.5"><span className="truncate">{a.nickname}</span>{a.source === "plaid" ? <Chip tone="info" title="Synced from Plaid Sandbox">Plaid</Chip> : null}</span></td>
                  <td className="hidden text-ink-2 sm:table-cell">{TYPE_LABEL[a.type]}</td>
                  <td className={cx("num r font-medium", debt && "text-risk")}>{debt ? `−${usd(a.balance)}` : usd(a.balance)}</td>
                  <td className="r">{mom === null ? <span className="text-ink-3">—</span> : <Delta value={mom} good={improving} text={`${mom >= 0 ? "+" : "−"}${Math.abs(mom).toFixed(1)}%`} className="!text-[0.72rem]" />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
      {rows.length > shown.length ? <p className="mt-2 text-[0.74rem] text-ink-3">+{rows.length - shown.length} more on My Picture</p> : null}
    </Panel>
  );
}

const KIND_ICON: Record<Obligation["kind"], typeof IconBank> = {
  loan: IconBank, bill: IconFile, subscription: IconRepeat, tuition: IconCap, insurance: IconShield, tax: IconLandmark,
};

export function UpcomingCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const rows = fin.upcoming.slice(0, 6);
  return (
    <Panel id="upcoming-obligations" title="Upcoming Obligations" info="The next due date of each recurring payment, from its due day of the month." className={className} right={<ViewAll href={`/room/${householdId}/obligations`}>View All</ViewAll>}>
      <ul className="divide-y divide-line">
        {rows.map((o) => {
          const Icon = KIND_ICON[o.kind] ?? IconFile;
          const tone: Tone = o.days <= 3 ? "risk" : o.days <= 7 ? "watch" : "neutral";
          return (
            <li key={o.id} className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
              <span className="text-ink-2"><Icon size={18} /></span>
              <span className="min-w-0 flex-1 truncate text-[0.82rem] font-medium">{o.name}</span>
              <span className="num shrink-0 text-[0.8rem] text-ink-2">{usd(o.amount)}</span>
              <Chip tone={tone} className="w-[5.2rem] shrink-0 justify-center">{o.when}</Chip>
            </li>
          );
        })}
        {!rows.length ? <li className="text-[0.82rem] text-ink-3">No recurring obligations on file.</li> : null}
      </ul>
    </Panel>
  );
}

function GoalGlyph({ title, size }: { title: string; size: number }) {
  if (/car|van|vehicle|truck/i.test(title)) return <IconCar size={size} />;
  if (/trip|travel|vacation|hawaii/i.test(title)) return <IconPlane size={size} />;
  if (/home|house|roof|down\s*payment/i.test(title)) return <IconHome size={size} />;
  if (/college|529|school|educat/i.test(title)) return <IconCap size={size} />;
  if (/card|visa|debt|loan|pay off/i.test(title)) return <IconCard size={size} />;
  return <IconTarget size={size} />;
}

export function GoalsCard({ goals, fin, householdId, className }: { goals: readonly Goal[]; fin: RoomFinance; householdId: string; className?: string }) {
  const shown = goals.slice(0, 4);
  const now = fin.today;
  return (
    <Panel
      id="shared-goals"
      title={<>Shared Goals <span className="font-normal text-ink-3">({goals.length} active)</span></>}
      className={className}
      right={
        <Link href={`/room/${householdId}/goals`} className="inline-flex items-center gap-1 text-[0.78rem] font-semibold text-brand-strong hover:underline">
          <IconPlus size={13} /> Add Goal
        </Link>
      }
    >
      <ul className="space-y-3">
        {shown.map((g) => {
          const prog = goalProgress(g, fin.accounts, now);
          return (
            <li key={g.id} className="flex items-center gap-3">
              <IconTile size={40}><GoalGlyph title={g.title} size={19} /></IconTile>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[0.85rem] font-semibold">{g.title}</p>
                  {prog ? <p className="num shrink-0 text-[0.76rem] text-ink-2">{usd(prog.saved)} / {usd(g.target_amount ?? 0)}</p> : null}
                </div>
                {prog ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <Progress value={prog.pct} tone="brand" label={`${g.title} progress (estimated)`} className="flex-1" />
                    <span className="num w-9 shrink-0 text-right text-[0.78rem] font-semibold">{Math.round(prog.pct)}%</span>
                  </div>
                ) : (
                  <p className="mt-1 text-[0.74rem] text-ink-3">{g.feasibility ? g.feasibility.replace("_", " ") : "Being checked by the agents"}</p>
                )}
              </div>
            </li>
          );
        })}
        {!shown.length ? <li className="text-[0.82rem] text-ink-3">No goals yet. Start Table Mode and the agents will find them.</li> : null}
      </ul>
      {shown.length ? <p className="mt-3 text-[0.72rem] text-ink-3">Progress is an estimate from linked savings or the goal timeline.</p> : null}
    </Panel>
  );
}

export function ContributionCard({ fin, className }: { fin: RoomFinance; className?: string }) {
  const c = fin.contributions;
  const totalShare = c.rows.reduce((s, r) => s + r.goalShare, 0);
  return (
    <Panel
      id="contribution-tracking"
      title="Contribution Tracking"
      info="Income is from member records. Contribution splits the household's monthly surplus by each earner's share of savings balances; goal share follows income. Both are estimates."
      className={className}
      right={<Chip title="Contribution and goal share are estimates">est.</Chip>}
    >
      {c.rows.length ? (
        <>
          <TableScroll>
            <table className="tbl min-w-[24rem]">
              <thead>
                <tr><th scope="col">Member</th><th scope="col" className="r">Income /mo</th><th scope="col" className="r">Contribution</th><th scope="col" className="r">Goal share</th><th scope="col" className="r">Variance</th></tr>
              </thead>
              <tbody>
                {c.rows.map((r) => (
                  <tr key={r.member.id}>
                    <td><span className="flex items-center gap-2"><Avatar name={r.member.name} size={22} /><span className="truncate font-medium">{r.member.name.split(" ")[0]}</span></span></td>
                    <td className="num r">{usd(r.income)}</td>
                    <td className="num r">{usd(r.contribution)}</td>
                    <td className="num r">{Math.round(r.goalShare * 100)}%</td>
                    <td className={cx("num r font-medium", Math.abs(r.variance) < 0.5 ? "text-ink-3" : r.variance > 0 ? "text-good" : "text-risk")}>{Math.abs(r.variance) < 0.5 ? "0%" : `${r.variance > 0 ? "+" : "−"}${Math.abs(Math.round(r.variance))}%`}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>Total</td><td className="num r">{usd(c.totalIncome)}</td><td className="num r">{usd(c.pool)}</td><td className="num r">{Math.round(totalShare * 100)}%</td><td className="r text-ink-3">—</td></tr>
              </tfoot>
            </table>
          </TableScroll>
          <p className="mt-2 text-[0.72rem] leading-snug text-ink-3">
            Monthly surplus available for goals: <span className="num">{usd(c.pool)}</span> (est.){c.dependents ? ` · ${c.dependents} ${c.dependents === 1 ? "dependent" : "dependents"} not shown` : ""}.
          </p>
        </>
      ) : (
        <p className="text-[0.82rem] text-ink-3">No member income on file yet.</p>
      )}
    </Panel>
  );
}

export type { Account };
