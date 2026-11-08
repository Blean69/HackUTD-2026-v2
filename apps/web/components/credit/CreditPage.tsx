"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { IconAlert, IconBell } from "@/components/icons";
import { Avatar, Chip, Disclosure, Empty, Notice, PageHeader, Panel, Progress, Skeleton, type Tone } from "@/components/ui";
import { useCredit } from "@/lib/data/credit-hooks";
import { BANDS, type CreditView } from "@/lib/finance-credit";
import { cx, longDate, relTime } from "@/lib/format";
import { CREDIT_BANDS, ScoreGauge } from "@/components/charts/ScoreGauge";
import { CreditTrend } from "./CreditTrend";

export const SIMULATED = "Simulated score for this demo";

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function ChangeText({ v, className }: { v: CreditView; className?: string }) {
  if (v.change === null) return null;
  const up = v.change >= 0;
  return (
    <span className={cx("num text-caption font-medium", v.change === 0 ? "text-ink-3" : up ? "text-good" : "text-risk", className)}>
      {v.change === 0 ? "No change" : `${up ? "+" : "−"}${Math.abs(v.change)} ${Math.abs(v.change) === 1 ? "pt" : "pts"}`}
      <span className="font-normal text-ink-3"> in {Math.max(1, v.history.length - 1)} mo</span>
    </span>
  );
}

/** One member per tab: name, score and band. On phones they scroll sideways; there are rarely more than three. */
function MemberTabs({ views, value, onChange }: { views: readonly CreditView[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" aria-label="Family member" className={cx("gap-2", views.length <= 3 ? "grid grid-cols-3 sm:flex" : "no-scrollbar -mx-4 flex overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0")}>
      {views.map((v) => {
        const on = v.member_id === value;
        return (
          <button
            key={v.member_id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(v.member_id)}
            className={cx(
              "press flex min-w-0 shrink-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors sm:min-w-[11rem]",
              on ? "border-brand bg-brand-soft" : "border-line bg-surface hover:bg-surface-2",
            )}
          >
            <span className="hidden sm:block"><Avatar name={v.name} size={30} /></span>
            <span className="min-w-0">
              <span className="block truncate text-label font-medium"><span className="sm:hidden">{first(v.name)}</span><span className="hidden sm:inline">{v.name}</span></span>
              <span className="flex items-baseline gap-1.5">
                <span className="figure num text-lead font-semibold">{v.score}</span>
                <span className="text-caption text-ink-3">{v.band.label}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const TONE_BAR: Record<"good" | "watch" | "risk", Tone> = { good: "good", watch: "watch", risk: "risk" };
const factorTone = (value: number): "good" | "watch" | "risk" => (value >= 0.7 ? "good" : value >= 0.45 ? "watch" : "risk");

/** Each factor: weight, points earned of the points available, a bar, and the one-line reason. */
function Factors({ v, householdId }: { v: CreditView; householdId: string }) {
  const total = v.factors.reduce((s, f) => s + f.points, 0);
  return (
    <ul className="divide-y divide-line">
      {v.factors.map((f) => {
        const tone = factorTone(f.value);
        const hero = f.key === "household_health";
        return (
          <li key={f.key} className={cx("py-3 first:pt-0 last:pb-0", hero && "")}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-body font-medium">
                {f.label}
                <span className="num ml-2 text-caption font-normal text-ink-3">{Math.round(f.weight * 100)}% weight</span>
              </p>
              <p className="num shrink-0 text-label">
                <span className="font-semibold text-ink">{Math.round(f.points)}</span>
                <span className="text-ink-3"> / {Math.round(f.max_points)} pts</span>
              </p>
            </div>
            <Progress value={f.value * 100} tone={TONE_BAR[tone]} label={`${f.label}: ${Math.round(f.value * 100)} of 100`} className="mt-2" />
            {f.explanation ? <p className="mt-1.5 text-label leading-snug text-ink-2">{f.explanation}</p> : null}
            {hero ? (
              <p className="mt-1 text-caption text-ink-3">
                In this simulated score, 45% comes from how the whole household is doing. Real credit scores such as FICO
                don&apos;t look at household savings or cash flow; this learning model does, to show how the two connect.{" "}
                <Link href={`/room/${householdId}#financial-health`} className="font-medium text-brand-strong hover:underline">See the health indicators</Link>
              </p>
            ) : null}
          </li>
        );
      })}
      <li className="flex items-baseline justify-between gap-3 pt-3 text-label">
        <span className="text-ink-2">300 base + factor points</span>
        <span className="num font-semibold">300 + {Math.round(total)} = {v.score}</span>
      </li>
    </ul>
  );
}

interface AlertItem {
  id: string;
  severity: "critical" | "warn" | "info";
  title: string;
  detail: string;
  when: string;
  derived?: boolean;
}

function Alerts({ items }: { items: readonly AlertItem[] }) {
  if (!items.length) return <Empty title="No credit alerts">You will see a note here when a score moves 15 points or more.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {items.slice(0, 6).map((a) => (
        <li key={a.id} className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0">
          <span className={cx("mt-0.5 shrink-0", a.severity === "info" ? "text-info" : a.severity === "warn" ? "text-watch" : "text-risk")}>
            {a.severity === "info" ? <IconBell size={16} /> : <IconAlert size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-label font-semibold leading-snug">{a.title}</p>
            {a.detail ? <p className="mt-0.5 text-label leading-snug text-ink-2">{a.detail}</p> : null}
            <p className="num mt-0.5 text-caption text-ink-3">{a.when}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function CreditSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading credit scores">
      <div className="flex gap-2"><Skeleton className="h-16 w-44 !rounded-lg" /><Skeleton className="h-16 w-44 !rounded-lg" /></div>
      <div className="grid grid-cols-12 gap-3">
        <Skeleton className="col-span-12 h-72 !rounded-lg md:col-span-5" />
        <Skeleton className="col-span-12 h-72 !rounded-lg md:col-span-7" />
        <Skeleton className="col-span-12 h-96 !rounded-lg" />
      </div>
    </div>
  );
}

/** Credit monitoring (contracts.md section 9): per member, the score on a 300-850 gauge, its trend, what shapes it, and alerts. */
export function CreditPage({ householdId }: { householdId: string }) {
  const credit = useCredit(householdId);
  const [picked, setPicked] = useState<string | null>(null);
  const v = credit.views.find((x) => x.member_id === picked) ?? credit.views[0];

  const alerts = useMemo<AlertItem[]>(() => {
    if (!v) return [];
    const name = first(v.name).toLowerCase();
    const live = credit.alerts
      .filter((a) => a.related_ids.includes(v.member_id) || a.title.toLowerCase().includes(name) || (!a.related_ids.length && credit.views.length === 1))
      .map((a) => ({ id: a.id, severity: a.severity, title: a.title, detail: a.detail, when: relTime(a.created_at) }));
    if (live.length || v.source === "live") return live;
    return credit.derivedAlerts.filter((a) => a.member_id === v.member_id).map((a) => ({ id: a.id, severity: a.severity, title: a.title, detail: a.detail, when: longDate(a.date), derived: true }));
  }, [credit.alerts, credit.derivedAlerts, credit.views.length, v]);

  const header = (
    <PageHeader
      title="Credit"
      sub="Each person's score, what moves it, and alerts when it changes."
      right={<Chip tone="info" title="A transparent synthetic score. No credit bureau is contacted.">{SIMULATED}</Chip>}
    />
  );

  if (!credit.ready) return <>{header}<CreditSkeleton /></>;
  if (!v) {
    return (
      <>
        {header}
        <Empty title="No credit profiles yet">Scores appear once a family member has a credit profile on file.</Empty>
      </>
    );
  }

  const lowest = Math.min(...v.history.map((h) => h.score));
  const highest = Math.max(...v.history.map((h) => h.score));
  return (
    <>
      {header}
      <div className="space-y-3">
        <Notice tone="info">
          A learning model, not a FICO score: it shows how a family&apos;s habits could move a score. No credit bureau is contacted.
        </Notice>
        {credit.views.length > 1 ? <MemberTabs views={credit.views} value={v.member_id} onChange={setPicked} /> : null}

        <div className="grid grid-cols-12 gap-3" role="tabpanel" aria-label={`${v.name}'s credit`}>
          <Panel
            id="credit-score"
            title={`${first(v.name)}'s score`}
            sub={v.updated_at ? `Updated ${relTime(v.updated_at)}` : "Recalculated from today's numbers"}
            className="col-span-12 md:col-span-5"
          >
            <div className="flex justify-center pt-1">
              <ScoreGauge value={v.score} min={300} max={850} bands={CREDIT_BANDS} label={`${first(v.name)}'s credit score`} size={208} caption="Simulated" />
            </div>
            <div className="mt-1 flex justify-center"><ChangeText v={v} /></div>
            <ol className="mt-4 grid grid-cols-5 gap-0.5 text-center" aria-label="Score bands">
              {BANDS.map((b) => (
                <li key={b.key} aria-current={b.key === v.band.key ? "true" : undefined} className={cx("rounded-md px-0.5 py-1.5", b.key === v.band.key ? "bg-surface-2" : "")}>
                  <span className={cx("block text-[10px] font-medium leading-tight sm:text-2xs", b.key === v.band.key ? "text-ink" : "text-ink-3")}>{b.label}</span>
                  <span className="num block text-2xs text-ink-3">{b.min}</span>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel
            id="credit-trend"
            title="Last six months"
            sub={v.history.length > 1 ? <span className="num">Low {lowest} · high {highest}</span> : undefined}
            className="col-span-12 md:col-span-7"
          >
            <CreditTrend points={v.history} className="mx-auto block w-full max-w-[480px]" />
          </Panel>

          <Panel
            id="credit-factors"
            title="What's shaping your score"
            sub="Six weighted factors in the app's simulated score. Household health counts the most here."
            className="col-span-12 lg:col-span-8"
          >
            <Factors v={v} householdId={householdId} />
          </Panel>

          <Panel id="credit-alerts" title="Recent credit alerts" className="col-span-12 lg:col-span-4">
            <Alerts items={alerts} />
          </Panel>
        </div>

        <Disclosure summary="How this score is calculated">
          <div className="max-w-3xl space-y-1.5 text-label leading-relaxed text-ink-2">
            <p>
              {SIMULATED}: a transparent stand-in for a bureau score, so the room can show monitoring without pulling anyone&apos;s real credit.
              Each factor scores 0 to 1 and is multiplied by its weight; the total maps onto 300 to 850.
            </p>
            <p className="num font-mono text-caption">score = 300 + 550 × (0.45 health + 0.20 payments + 0.15 utilization + 0.08 history + 0.06 new credit + 0.06 mix)</p>
            <p>A move of 15 points or more raises an alert for everyone in the room.{v.source === "derived" ? " This view is computed in the browser from the credit profile and household health until the database publishes its own score." : ""}</p>
          </div>
        </Disclosure>
      </div>
    </>
  );
}
