"use client";
import { Area, Bar, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Chip, SectionTitle } from "@/components/ui";
import { longDate, shortDate, usd } from "@/lib/format";
import type { ForecastPoint } from "@/lib/types";

export interface Overlay { date: string; scenario: number }

interface TipProps {
  active?: boolean;
  payload?: { payload: { date: string; balance: number; obligations_due: number; scenario?: number } }[];
}
function Tip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl border border-line-strong bg-surface px-3 py-2 text-[0.8rem] shadow-card">
      <p className="font-semibold">{longDate(p.date)}</p>
      <p className="num text-ink-2">Checking: <span className="font-semibold text-ink">{usd(p.balance)}</span></p>
      {p.scenario !== undefined ? <p className="num text-ink-2">With change: <span className="font-semibold text-accent">{usd(p.scenario)}</span></p> : null}
      {p.obligations_due > 0 ? <p className="num text-watch">Bills due: {usd(p.obligations_due)}</p> : null}
    </div>
  );
}

const BUFFER = 1500;

export function ForecastChart({ points, low, overlay, height = 230, title = "Next 90 days", embedded }: {
  points: readonly ForecastPoint[];
  low: { date: string; balance: number } | null;
  overlay?: readonly { date: string; scenario: number }[];
  height?: number;
  title?: string;
  /** No section heading or card chrome: used inside another card (what-if results). */
  embedded?: boolean;
}) {
  if (!points.length) return <Card className="skeleton h-72" aria-busy="true" />;
  const over = new Map((overlay ?? []).map((o) => [o.date, o.scenario]));
  const data = points.map((p) => ({ ...p, scenario: over.get(p.date) }));
  const maxObl = Math.max(1, ...points.map((p) => p.obligations_due));
  const tight = low ? low.balance < BUFFER : false;
  const Wrap = embedded ? "div" : Card;
  return (
    <section aria-labelledby={embedded ? undefined : "fc-h"} aria-label={embedded ? title : undefined}>
      {embedded ? null : (
        <SectionTitle
          id="fc-h"
          title="Cash forecast"
          sub={title}
          right={low ? <Chip tone={low.balance < 0 ? "risk" : tight ? "watch" : "good"}>Low {usd(low.balance, { compact: true })}</Chip> : undefined}
        />
      )}
      <Wrap className={embedded ? "" : "p-3 pt-4"}>
        <p className="px-1 pb-2 text-[0.84rem] leading-snug text-ink-2">
          {low ? (
            <>Checking bottoms out at <span className="num font-semibold text-ink">{usd(low.balance)}</span> on <span className="font-semibold text-ink">{longDate(low.date)}</span>
              {tight ? <span className="text-watch"> — under a {usd(BUFFER)} safety buffer.</span> : <span>, comfortably above a {usd(BUFFER)} buffer.</span>}</>
          ) : null}
        </p>
        <div style={{ height }} role="img" aria-label={low ? `Forecast chart. Lowest balance ${usd(low.balance)} on ${longDate(low.date)}.` : "Forecast chart"}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="fcfill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: "var(--ink-3)" }} tickLine={false} axisLine={{ stroke: "var(--line-strong)" }} minTickGap={36} />
              <YAxis yAxisId="bal" tickFormatter={(v: number) => usd(v, { compact: true })} tick={{ fontSize: 11, fill: "var(--ink-3)" }} tickLine={false} axisLine={false} width={46} domain={["auto", "auto"]} />
              <YAxis yAxisId="obl" hide domain={[0, maxObl * 5]} />
              <Tooltip content={<Tip />} cursor={{ stroke: "var(--line-strong)" }} />
              <ReferenceLine yAxisId="bal" y={BUFFER} stroke="var(--watch)" strokeDasharray="4 4" strokeOpacity={0.7} />
              <Bar yAxisId="obl" dataKey="obligations_due" fill="var(--accent)" barSize={3} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Area yAxisId="bal" type="monotone" dataKey="balance" stroke="var(--brand)" strokeWidth={2.25} fill="url(#fcfill)" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              {overlay ? <Line yAxisId="bal" type="monotone" dataKey="scenario" stroke="var(--accent)" strokeWidth={2.25} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls /> : null}
              {low ? <ReferenceDot yAxisId="bal" x={low.date} y={low.balance} r={6} fill="var(--risk)" stroke="var(--surface)" strokeWidth={2} /> : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[0.72rem] text-ink-2">
          <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-brand" aria-hidden="true" /> Checking balance</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-0.5 bg-accent" aria-hidden="true" /> Bill or loan payment due</li>
          <li className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-risk" aria-hidden="true" /> Low point</li>
          <li className="flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-watch" aria-hidden="true" /> {usd(BUFFER)} safety buffer</li>
          {overlay ? <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 border-t-2 border-dashed border-accent" aria-hidden="true" /> With your what-if</li> : null}
        </ul>
      </Wrap>
    </section>
  );
}
