"use client";
import { useState, type FormEvent } from "react";
import { Mascot } from "@/components/Mascot";
import { CountUp } from "@/components/motion";
import { Avatar, Button, Chip, Empty, PageHeader, Panel, Progress, Segmented, Skeleton, inputCls, labelCls } from "@/components/ui";
import { addKidTask, approveKidTask, completeKidTask, deleteKidTask, redeemKidGoal, reopenKidTask, setKidGoal } from "@/lib/data/actions";
import { useKidJars, useKidTasks, useMembers, useRoomTables } from "@/lib/data/hooks";
import { useLocalIdentity } from "@/lib/data/identity";
import { cx, usd } from "@/lib/format";
import type { KidJar, KidTask, Member } from "@/lib/types";
import { TeenPlan } from "./TeenPlan";

const PRESETS: [string, number][] = [["Make your bed", 2], ["Do the dishes", 3], ["Walk the dog", 4], ["Homework done", 2], ["Take out the trash", 1]];
const run = (p: Promise<unknown>) => void p.catch(() => undefined);

/** Under 13 is Kid mode (jar and chores); 13 and up also gets Teen mode (loans and a first budget). */
const modeOf = (m: Member) => (m.age <= 12 ? "kid" : "teen");

function Jar({ jar }: { jar?: KidJar }) {
  const bal = jar?.balance ?? 0;
  const goal = jar?.goal_target ?? 0;
  const pct = goal > 0 ? Math.min(1, bal / goal) : Math.min(1, bal / 50);
  return (
    <svg viewBox="0 0 120 130" width="120" height="130" role="img" aria-label={`Jar ${usd(bal)}${goal ? ` of ${usd(goal)}` : ""}`} className="shrink-0">
      <defs><clipPath id="jar-in"><path d="M24 30h72v78a12 12 0 0 1-12 12H36a12 12 0 0 1-12-12z" /></clipPath></defs>
      <g clipPath="url(#jar-in)">
        <rect x="20" y="30" width="80" height="90" fill="var(--surface-3)" />
        <rect x="20" y="30" width="80" height="90" fill="#f4c430" style={{ transformOrigin: "50% 100%", transform: `scaleY(${pct})`, transition: "transform 900ms var(--ease-out)" }} />
        {pct > 0.12 ? [[40, 100], [62, 106], [82, 98], [52, 88]].map(([x, y], i) => pct * 90 > 120 - y + 6 ? <circle key={i} cx={x} cy={y} r="7" fill="#e0a800" stroke="#fff3b0" strokeWidth="1.5" /> : null) : null}
      </g>
      <path d="M24 30h72v78a12 12 0 0 1-12 12H36a12 12 0 0 1-12-12z" fill="none" stroke="var(--line-strong)" strokeWidth="3" />
      <rect x="20" y="20" width="80" height="12" rx="5" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="3" />
    </svg>
  );
}

function TaskRow({ t, who }: { t: KidTask; who: "kid" | "parent" }) {
  const [busy, setBusy] = useState(false);
  const go = (fn: () => Promise<unknown>) => { setBusy(true); void fn().catch(() => undefined).finally(() => setBusy(false)); };
  return (
    <li className="motion-fade flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={cx("truncate text-body font-medium", t.status === "approved" && "text-ink-3 line-through")}>{t.title}</p>
        <p className="num text-caption text-ink-3">{usd(t.reward, { cents: t.reward % 1 !== 0 })}</p>
      </div>
      {who === "kid" ? (
        t.status === "open" ? <Button size="md" disabled={busy} onClick={() => go(() => completeKidTask(t.id))}>I did it!</Button>
        : t.status === "done" ? <Chip tone="watch">Waiting for a parent</Chip>
        : <Chip tone="good">Paid</Chip>
      ) : t.status === "done" ? (
        <span className="flex gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => go(() => approveKidTask(t.id))}>Approve</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => go(() => reopenKidTask(t.id))}>Not yet</Button>
        </span>
      ) : t.status === "open" ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => go(() => deleteKidTask(t.id))}>Remove</Button>
      ) : <Chip tone="good">Paid</Chip>}
    </li>
  );
}

function GoalEditor({ householdId, member, jar }: { householdId: string; member: Member; jar?: KidJar }) {
  const [title, setTitle] = useState(jar?.goal_title ?? "");
  const [target, setTarget] = useState(jar?.goal_target ? String(jar.goal_target) : "");
  const save = (e: FormEvent) => { e.preventDefault(); run(setKidGoal(householdId, member.id, title, Number(target) || 0)); };
  return (
    <form onSubmit={save} className="mt-3 grid grid-cols-[1fr_6rem_auto] items-end gap-2">
      <div><label className={labelCls} htmlFor={`g-${member.id}`}>Saving for</label><input id={`g-${member.id}`} className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Lego set" maxLength={60} /></div>
      <div><label className={labelCls} htmlFor={`gt-${member.id}`}>Cost ($)</label><input id={`gt-${member.id}`} className={inputCls} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="25" /></div>
      <Button type="submit" variant="secondary" disabled={!title.trim() || !(Number(target) > 0)}>Set</Button>
    </form>
  );
}

function KidView({ householdId, member, tasks, jar }: { householdId: string; member: Member; tasks: KidTask[]; jar?: KidJar }) {
  const bal = jar?.balance ?? 0;
  const goal = jar?.goal_target ?? 0;
  const reached = goal > 0 && bal >= goal;
  const [won, setWon] = useState("");
  const left = tasks.filter((t) => t.status !== "approved");
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel title={`${member.name.split(" ")[0]}'s jar`} className="col-span-12 md:col-span-5" mascot={reached ? "cheer" : "happy"}>
        <div className="flex items-center gap-4">
          <Jar jar={jar} />
          <div className="min-w-0">
            <p className="figure text-[2.25rem] leading-10"><CountUp value={bal} format={(n) => usd(n, { cents: true })} /></p>
            <p className="text-caption text-ink-3">Earned so far: <span className="num">{usd(jar?.earned_total ?? 0)}</span></p>
          </div>
        </div>
        {goal > 0 ? (
          <div className="mt-3">
            <div className="flex justify-between text-label"><span className="font-medium">{jar?.goal_title}</span><span className="num text-ink-2">{usd(Math.min(bal, goal))} of {usd(goal)}</span></div>
            <Progress value={(bal / goal) * 100} tone={reached ? "good" : "brand"} label="Progress to your goal" className="mt-1.5" height="h-2.5" />
            {reached ? (
              <Button size="lg" className="motion-pop mt-3 w-full" onClick={() => { setWon(jar?.goal_title ?? ""); run(redeemKidGoal(member.id)); }}>Get my {jar?.goal_title}!</Button>
            ) : <p className="mt-1.5 text-caption text-ink-3">{usd(goal - bal)} to go. Every chore gets you closer.</p>}
          </div>
        ) : null}
        {won ? <p className="motion-pop mt-3 rounded-lg bg-good-soft px-3 py-2 text-label font-medium text-good">You saved up and bought: {won}. Nice work!</p> : null}
        <GoalEditor key={`${member.id}:${jar?.goal_title}:${jar?.goal_target}`} householdId={householdId} member={member} jar={jar} />
      </Panel>
      <Panel title="My chores" sub="Finish one, tap the button, and a parent pays you." className="col-span-12 md:col-span-7">
        {left.length ? <ul className="space-y-2">{left.map((t) => <TaskRow key={t.id} t={t} who="kid" />)}</ul> : <Empty title="All caught up">Ask a parent to add a chore.</Empty>}
      </Panel>
    </div>
  );
}

function ParentView({ householdId, member, tasks }: { householdId: string; member: Member; tasks: KidTask[] }) {
  const id = useLocalIdentity();
  const [title, setTitle] = useState("");
  const [reward, setReward] = useState("2");
  const add = (t: string, r: number) => run(addKidTask({ householdId, memberId: member.id, title: t, reward: r, authorName: id.name ?? "A parent" }));
  const waiting = tasks.filter((t) => t.status === "done");
  const rest = tasks.filter((t) => t.status !== "done");
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel title={`Add a chore for ${member.name.split(" ")[0]}`} className="col-span-12 md:col-span-5">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(([t, r]) => <Button key={t} size="sm" variant="secondary" onClick={() => add(t, r)}>{t} · ${r}</Button>)}
        </div>
        <form className="mt-3 grid grid-cols-[1fr_5rem_auto] items-end gap-2" onSubmit={(e) => { e.preventDefault(); add(title, Number(reward) || 0); setTitle(""); }}>
          <div><label className={labelCls} htmlFor="chore-title">Your own chore</label><input id="chore-title" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Water the plants" /></div>
          <div><label className={labelCls} htmlFor="chore-reward">Pays ($)</label><input id="chore-reward" className={inputCls} inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} /></div>
          <Button type="submit" disabled={!title.trim()}>Add</Button>
        </form>
      </Panel>
      <Panel title="Waiting for you" sub={waiting.length ? `${waiting.length} chore${waiting.length > 1 ? "s" : ""} to check` : undefined} className="col-span-12 md:col-span-7">
        {waiting.length ? <ul className="space-y-2">{waiting.map((t) => <TaskRow key={t.id} t={t} who="parent" />)}</ul> : <p className="text-label text-ink-3">Nothing to approve right now.</p>}
        {rest.length ? <><p className="eyebrow mb-2 mt-4">Everything else</p><ul className="space-y-2">{rest.map((t) => <TaskRow key={t.id} t={t} who="parent" />)}</ul></> : null}
      </Panel>
    </div>
  );
}

/** Kids and teens: chores earn allowance into a savings jar (live on every phone), and teens get a loan and first-budget planner. */
export function KidsPage({ householdId }: { householdId: string }) {
  const ready = useRoomTables(householdId, ["kid_task", "kid_jar"]);
  const members = useMembers(householdId);
  const tasks = useKidTasks(householdId);
  const jars = useKidJars(householdId);
  const people = members.filter((m) => m.role === "child" || m.age <= 26);
  const [pick, setPick] = useState("");
  const [view, setView] = useState<"play" | "parent">("play");
  const header = <PageHeader title="Kids & Teens" sub="Chores earn allowance into a savings jar. Teens get a loan and first-budget planner." />;
  if (!ready) return <>{header}<Skeleton className="h-64 w-full !rounded-lg" /></>;
  if (!people.length) return <>{header}<Empty title="No kids or teens in this household">Add a younger family member to start a jar.</Empty></>;
  const me = people.find((m) => m.id === pick) ?? people[0];
  const mode = modeOf(me);
  const mine = tasks.filter((t) => t.member_id === me.id);
  return (
    <>
      {header}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {people.map((m) => (
          <button key={m.id} type="button" aria-pressed={m.id === me.id} onClick={() => setPick(m.id)} className={cx("press flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-label font-medium", m.id === me.id ? "border-brand bg-brand-soft text-brand-strong" : "border-line-strong text-ink-2 hover:bg-surface-2")}>
            <Avatar name={m.name} size={26} />{m.name.split(" ")[0]}<span className="text-caption text-ink-3">{m.age}</span>
          </button>
        ))}
        <span className="flex-1" />
        <Segmented<"play" | "parent"> label="View" value={view} onChange={setView} options={[{ value: "play", label: mode === "kid" ? "Kid view" : "Teen view" }, { value: "parent", label: "Parent view" }]} />
      </div>
      {view === "parent" ? <ParentView householdId={householdId} member={me} tasks={mine} />
        : mode === "kid" ? <KidView householdId={householdId} member={me} tasks={mine} jar={jars.get(me.id)} />
        : <div className="space-y-3"><TeenPlan member={me} /><KidView householdId={householdId} member={me} tasks={mine} jar={jars.get(me.id)} /></div>}
      <div className="mt-4 flex items-center gap-2 text-caption text-ink-3"><Mascot size={28} />Penny keeps score. Parents approve every chore before money moves.</div>
    </>
  );
}
