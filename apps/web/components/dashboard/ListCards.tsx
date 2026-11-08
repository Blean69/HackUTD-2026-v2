"use client";
import Link from "next/link";
import { useMemo } from "react";
import { useNow } from "@/lib/data/finance-hooks";
import { IconBank, IconCap, IconCar, IconCard, IconChart, IconChevron, IconFile, IconHome, IconLandmark, IconPiggy, IconRepeat, IconShield, IconWallet } from "@/components/icons";
import { List, ListRow, Panel, PanelLink, Progress } from "@/components/ui";
import type { RoomFinance } from "@/lib/data/finance-hooks";
import { goalProgress } from "@/lib/finance";
import { ACCOUNT_GROUPS, cx, relTime, shortDate, usd } from "@/lib/format";
import type { Goal, Obligation } from "@/lib/types";

const GROUP_ICON: Record<string, typeof IconBank> = { checking: IconWallet, savings: IconPiggy, cd_ira: IconChart, loans: IconCar, cards: IconCard, mortgage: IconHome };
const DOT = { good: "bg-good", watch: "bg-watch", risk: "bg-risk" } as const;

/**
 * The 360° view, in the order of PNC's brief: checking, savings, CDs & IRAs, loans, credit cards, mortgages. Always six
 * tiles, so a missing product reads as "None linked" instead of silently disappearing. The full table lives on My Picture.
 */
export function ProductStrip({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const now = useNow(60_000);
  const tiles = useMemo(() => {
    const ind = (k: string) => fin.health.find((h) => h.key === k)?.status;
    return ACCOUNT_GROUPS.map((g) => {
      const rows = fin.accounts.filter((a) => g.types.includes(a.type));
      const total = rows.reduce((s, a) => s + Math.abs(a.balance), 0);
      let sub = rows.length ? `${rows.length} account${rows.length > 1 ? "s" : ""}` : "";
      let status: "good" | "watch" | "risk" | undefined;
      if (g.key === "savings") status = ind("emergency_fund");
      if (g.key === "checking") status = ind("forecast_low_point");
      if (g.key === "cd_ira") {
        const next = rows.filter((a) => a.maturity_date && Date.parse(a.maturity_date) >= now.getTime()).sort((a, b) => a.maturity_date!.localeCompare(b.maturity_date!))[0];
        if (next) sub = `CD matures ${shortDate(next.maturity_date!)}`;
      }
      if (g.key === "loans") {
        const pay = rows.reduce((s, a) => s + (a.monthly_payment ?? 0), 0);
        if (pay) sub = `${usd(pay)}/mo`;
        status = ind("debt_to_income");
      }
      if (g.key === "cards") {
        const limit = rows.reduce((s, a) => s + (a.credit_limit ?? 0), 0);
        if (limit) sub = `${Math.round((total / limit) * 100)}% of limit used`;
        status = ind("credit_utilization");
      }
      if (g.key === "mortgage") {
        const home = fin.household?.home_value ?? 0;
        if (home && total) sub = `${Math.round((total / home) * 100)}% loan-to-value`;
      }
      return { ...g, count: rows.length, total, sub, status: rows.length ? status : undefined };
    });
  }, [fin.accounts, fin.health, fin.household, now]);
  const picture = `/room/${householdId}/picture`;
  const allPlaid = fin.accounts.length > 0 && fin.accounts.every((a) => a.source === "plaid");
  const institutions = new Set(fin.accounts.map((a) => a.institution)).size;
  const asOf = fin.health.reduce((m, h) => (h.updated_at > m ? h.updated_at : m), "");

  return (
    <section id="accounts-overview" aria-labelledby="accounts-overview-h" className={cx("card", className)}>
      <header className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
        <h2 id="accounts-overview-h" className="text-lead font-semibold tracking-[-0.01em] text-ink">
          Every account, one view <span className="num font-normal text-ink-3">{fin.accounts.length}</span>
        </h2>
        <span className="text-caption text-ink-3"><PanelLink href={picture}>All accounts</PanelLink></span>
      </header>
      <p className="num px-4 text-caption text-ink-3">
        {institutions} institution{institutions === 1 ? "" : "s"}{allPlaid ? " · synced from Plaid Sandbox" : ""}{asOf ? ` · recomputed ${relTime(asOf, now.getTime())}` : ""}
      </p>
      <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-b-lg p-3 pt-2.5 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => {
          const Icon = GROUP_ICON[t.key] ?? IconBank;
          return (
            <li key={t.key}>
              <Link
                href={t.count ? `${picture}#group-${t.key}` : picture}
                className="press flex h-full flex-col gap-2 rounded-md p-2.5 hover:bg-surface-2"
                aria-label={t.count ? `${t.label}: ${usd(t.total)}${t.sub ? `, ${t.sub}` : ""}` : `${t.label}: none linked`}
              >
                <span className="flex items-center gap-2">
                  <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", t.count ? "bg-dark text-dark-ink" : "bg-surface-2 text-ink-3")}>
                    <Icon size={16} />
                  </span>
                  <span className="truncate text-label font-medium text-ink-2">{t.label}</span>
                  {t.status ? <span className={cx("ml-auto h-2 w-2 shrink-0 rounded-full", DOT[t.status])} title={`Health: ${t.status}`} /> : null}
                </span>
                {t.count ? (
                  <span>
                    <span className="figure block text-lead text-ink">{t.liability ? `−${usd(t.total)}` : usd(t.total)}</span>
                    <span className="num block truncate text-caption text-ink-3">{t.sub}</span>
                  </span>
                ) : (
                  <span className="text-caption text-ink-3">None linked · <span className="font-medium text-brand-strong">Connect</span></span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const KIND_ICON: Record<Obligation["kind"], typeof IconBank> = {
  loan: IconBank, bill: IconFile, subscription: IconRepeat, tuition: IconCap, insurance: IconShield, tax: IconLandmark,
};

export function UpcomingCard({ fin, householdId, className }: { fin: RoomFinance; householdId: string; className?: string }) {
  const rows = fin.upcoming.slice(0, 5);
  return (
    <Panel id="upcoming-obligations" title="Next bills" className={className} flush footer={<PanelLink href={`/room/${householdId}/picture?tab=bills`}>All bills</PanelLink>}>
      <List>
        {rows.map((o) => {
          const Icon = KIND_ICON[o.kind] ?? IconFile;
          return (
            <ListRow
              key={o.id}
              className="[&>div]:min-h-11"
              leading={<span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-2 text-ink-3"><Icon size={15} /></span>}
              title={o.name}
              trailing={usd(o.amount)}
              meta={<span className={cx("num", o.days <= 3 ? "font-semibold text-risk" : o.days <= 7 ? "font-medium text-watch" : "")}>{o.when}</span>}
            />
          );
        })}
        {!rows.length ? <li className="px-4 py-2 text-label text-ink-3">No recurring bills on file.</li> : null}
      </List>
    </Panel>
  );
}

/** The same labels as the Goals page and Table Mode, for every feasibility value. */
const FEAS: Record<string, { text: string; cls: string; tone: "good" | "watch" | "risk" | "brand" }> = {
  on_track: { text: "On track", cls: "text-good", tone: "brand" },
  stretch: { text: "Stretch", cls: "text-watch", tone: "watch" },
  off_track: { text: "Off track", cls: "text-risk", tone: "risk" },
  needs_details: { text: "Needs an amount", cls: "text-ink-3", tone: "brand" },
  not_advised: { text: "Not advised", cls: "text-risk", tone: "risk" },
};
/** A goal with no status yet reads "Checking" while the agents may still be on it (updated in the last 5 minutes), then "Not checked". */
const FRESH_MS = 5 * 60_000;

export function GoalsCard({ goals, fin, householdId, className }: { goals: readonly Goal[]; fin: RoomFinance; householdId: string; className?: string }) {
  const shown = goals.slice(0, 5);
  const href = `/room/${householdId}/goals`;
  const now = useNow();
  return (
    <Panel
      id="shared-goals"
      title={<>Goals <span className="num font-normal text-ink-3">{goals.length}</span></>}
      className={className}
      flush
      footer={<PanelLink href={href}>All goals</PanelLink>}
    >
      <ul className="divide-y divide-line">
        {shown.map((g) => {
          const prog = goalProgress(g, fin.accounts, fin.today);
          const f = g.feasibility ? FEAS[g.feasibility] : null;
          const fresh = now.getTime() - Date.parse(g.updated_at || g.created_at) < FRESH_MS;
          return (
            <li key={g.id}>
              <Link href={href} className="press group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="line-clamp-2 min-w-0 text-body font-medium leading-snug">{g.title}</span>
                    {f ? (
                      <span className={cx("shrink-0 text-caption font-medium", f.cls)}>{f.text}</span>
                    ) : (
                      <span className="shrink-0 text-caption text-ink-3" title={fresh ? "The agents are checking this against your accounts" : "No check ran for this goal. Edit it to add an amount and a date."}>
                        {fresh ? "Checking" : "Not checked"}
                      </span>
                    )}
                  </span>
                  {prog ? (
                    <span className="mt-2 flex items-center gap-2.5">
                      <Progress value={prog.pct} tone={f?.tone ?? "brand"} label={`${g.title} progress`} className="flex-1" />
                      <span className="num shrink-0 text-caption text-ink-2">{usd(prog.saved, { compact: true })} / {usd(g.target_amount ?? 0, { compact: true })}</span>
                    </span>
                  ) : null}
                </span>
                <IconChevron size={16} className="-mr-1 mt-0.5 shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
        {!shown.length ? <li className="px-4 py-2 text-label text-ink-3">No goals yet. <Link href={`/room/${householdId}/table`} className="font-medium text-brand-strong hover:underline">Play a sample conversation in Table Mode</Link> and the agents will find them.</li> : null}
      </ul>
    </Panel>
  );
}
