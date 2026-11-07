"use client";
import { useState, type ReactNode, type Ref } from "react";
import { IconPlus } from "@/components/icons";
import { Button } from "@/components/ui";
import { cx } from "@/lib/format";
import { useMembers } from "@/lib/data/hooks";
import {
  defaultAnswers, friendlyError, GOAL_TEXT_MAX, MAX_PRIORITIES, onboarding, PRIORITIES, RISK_LEVELS, ROLES, type AnswerMember,
  type HouseholdProfile, type OnboardingAnswers, type OnboardingBank,
} from "@/lib/data/onboarding";
import type { Member, MemberRole } from "@/lib/types";
import { BusyLabel, Field, fieldCls, MoneyField, Notice, NumberField, StepFooter, StepHeading, Switch, TextField } from "../fields";
import { SyncStatus } from "../SyncStatus";

function Section({ id, title, sub, children }: { id: string; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-line pt-5">
      <h2 id={id} className="text-[1rem] font-semibold leading-tight">
        {title}
      </h2>
      {sub ? <p className="mt-1 text-[0.84rem] leading-snug text-ink-2">{sub}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * Start from what is already stored: the household's real members (the creator exists from step 2, with an id so a
 * rename updates them instead of adding a duplicate), then anything saved before (a refresh, or Back from the last step).
 */
function initial(profile: HouseholdProfile | undefined, people: readonly Member[], name: string): OnboardingAnswers {
  const base = defaultAnswers(name);
  const saved = profile?.answers ?? {};
  const existing: AnswerMember[] = people.map((m) => ({ id: m.id, name: m.name, role: m.role, age: m.age, income_annual: m.income_annual }));
  const extra = (saved.members ?? []).filter((m) => !m.id && m.name && !existing.some((e) => e.name.toLowerCase() === m.name.toLowerCase()));
  const members = existing.length ? [...existing, ...extra] : saved.members?.length ? saved.members : base.members;
  return {
    ...base,
    ...saved,
    members,
    priorities: saved.priorities ?? profile?.priorities ?? base.priorities,
    risk_comfort: saved.risk_comfort ?? profile?.risk_comfort ?? base.risk_comfort,
  };
}

/** Step 5: friendly questions, asked while the bank sync runs in the background (`save_onboarding_answers`). */
export function AboutStep({
  householdId, bank, profile, defaultName, onBack, onDone, headingRef,
}: {
  householdId: string;
  bank?: OnboardingBank;
  profile?: HouseholdProfile;
  defaultName: string;
  onBack: () => void;
  onDone: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const people = useMembers(householdId);
  const [a, setA] = useState<OnboardingAnswers>(() => initial(profile, people, defaultName));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof OnboardingAnswers>(k: K, v: OnboardingAnswers[K]) => setA((p) => ({ ...p, [k]: v }));
  const setMember = (i: number, patch: Partial<AnswerMember>) => setA((p) => ({ ...p, members: p.members.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const risk = RISK_LEVELS[a.risk_comfort - 1] ?? RISK_LEVELS[2];
  const full = a.priorities.length >= MAX_PRIORITIES;

  function togglePriority(key: string) {
    set("priorities", a.priorities.includes(key) ? a.priorities.filter((k) => k !== key) : full ? a.priorities : [...a.priorities, key]);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const members = a.members.filter((m) => m.name.trim()).map((m) => ({ ...m, name: m.name.trim() }));
      await onboarding.save(householdId, { ...a, members, goal_text: a.goal_text.trim().slice(0, GOAL_TEXT_MAX), home_value: a.own_home ? a.home_value : 0 });
      onDone();
    } catch (e) {
      setErr(friendlyError(e, "We couldn't save your answers. Please try again."));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <StepHeading headingRef={headingRef} title="A little about you" sub="Skip anything you are not sure about. Rough numbers are perfect, and you can change all of this later." />

      {bank && bank.status !== "selecting" ? (
        <div className="mb-5">
          <SyncStatus bank={bank} compact />
        </div>
      ) : null}

      <div className="space-y-5">
      <Section id="who-h" title="Who is in your household?" sub="Add everyone whose money is part of this picture, partners included.">
        <ul className="space-y-3">
          {a.members.map((m, i) => (
            <li key={i} className="rounded-lg border border-line bg-surface-2/60 p-3">
              <div className="grid grid-cols-2 gap-3">
                <TextField id={`m${i}-name`} label="Name" value={m.name} onChange={(v) => setMember(i, { name: v })} autoComplete={i === 0 ? "given-name" : "off"} maxLength={32} className="col-span-2" />
                <Field label="Role" htmlFor={`m${i}-role`}>
                  <select id={`m${i}-role`} value={m.role} onChange={(e) => setMember(i, { role: e.target.value as MemberRole })} className={fieldCls}>
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <NumberField id={`m${i}-age`} label="Age" value={m.age} onChange={(n) => setMember(i, { age: n })} placeholder="35" />
                <MoneyField id={`m${i}-income`} label="Yearly income before taxes" value={m.income_annual} onChange={(n) => setMember(i, { income_annual: n })} placeholder="60,000" className="col-span-2" />
              </div>
              {!m.id ? (
                <div className="mt-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => set("members", a.members.filter((_, j) => j !== i))} aria-label={`Remove ${m.name || `person ${i + 1}`}`}>
                    Remove
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {a.members.length < 8 ? (
          <Button variant="secondary" className="mt-3" onClick={() => set("members", [...a.members, { name: "", role: "parent", age: 0, income_annual: 0 }])}>
            <IconPlus size={16} /> Add someone
          </Button>
        ) : null}
      </Section>

      <Section id="home-h" title="Your home and car" sub="Used for your net worth. A ballpark is fine.">
        <fieldset>
          <legend className="sr-only">Do you own or rent?</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["rent", "own"] as const).map((h) => (
              <label
                key={h}
                className={cx(
                  "flex h-12 cursor-pointer items-center justify-center rounded-md border text-[0.92rem] font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)]",
                  (a.own_home ? "own" : "rent") === h ? "border-brand bg-brand-soft text-brand-strong" : "border-line-strong text-ink-2 hover:bg-surface-2",
                )}
              >
                <input type="radio" name="housing" value={h} checked={(a.own_home ? "own" : "rent") === h} onChange={() => set("own_home", h === "own")} className="sr-only" />
                {h === "rent" ? "I rent" : "I own"}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {a.own_home ? <MoneyField id="home-value" label="About what is your home worth?" value={a.home_value} onChange={(n) => set("home_value", n)} placeholder="350,000" /> : null}
          <MoneyField id="vehicle-value" label="About what are your vehicles worth?" value={a.vehicle_value} onChange={(n) => set("vehicle_value", n)} placeholder="18,000" hint="Add them together. Leave blank if none." />
        </div>
      </Section>

      <Section id="prio-h" title="What matters most right now?" sub={`Pick up to ${MAX_PRIORITIES}. We will build your plan around these.`}>
        <div role="group" aria-labelledby="prio-h" className="flex flex-wrap gap-2">
          {PRIORITIES.map((p) => {
            const idx = a.priorities.indexOf(p.key);
            const on = idx >= 0;
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={on}
                disabled={!on && full}
                onClick={() => togglePriority(p.key)}
                className={cx(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-[0.88rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                  on ? "border-brand bg-brand text-brand-ink" : "border-line-strong bg-surface text-ink hover:bg-surface-2",
                )}
              >
                {on ? <span className="num inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/25 text-[0.72rem]">{idx + 1}</span> : null}
                {p.label}
              </button>
            );
          })}
        </div>
        <p className="num mt-2 text-[0.8rem] text-ink-3" aria-live="polite">
          {a.priorities.length} of {MAX_PRIORITIES} picked{full ? ". Tap a chosen one to swap it out." : "."}
        </p>
        <Field label="Anything else you are planning?" htmlFor="other-goal" className="mt-4">
          <textarea
            id="other-goal"
            value={a.goal_text}
            onChange={(e) => set("goal_text", e.target.value)}
            rows={2}
            maxLength={GOAL_TEXT_MAX}
            placeholder="A second shop, a family trip, helping with a wedding…"
            className={cx(fieldCls, "h-auto resize-none py-2.5 leading-snug")}
          />
        </Field>
      </Section>

      <Section id="risk-h" title="How do you feel about investment risk?" sub="There is no right answer. It helps us suggest the right pace.">
        <div className="rounded-lg border border-line bg-surface-2/60 px-3.5 pb-3 pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[1rem] font-semibold">{risk.label}</p>
            <p className="num text-[0.8rem] text-ink-3">{a.risk_comfort} of 5</p>
          </div>
          <p className="mt-0.5 min-h-[2.4em] text-[0.84rem] leading-snug text-ink-2">{risk.hint}</p>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={a.risk_comfort}
            onChange={(e) => set("risk_comfort", Number(e.target.value))}
            aria-labelledby="risk-h"
            aria-valuetext={`${a.risk_comfort} of 5: ${risk.label}`}
            className="mt-2 h-11 w-full cursor-pointer accent-brand"
          />
          <div className="flex justify-between text-[0.7rem] leading-tight text-ink-3" aria-hidden="true">
            <span>Safety first</span>
            <span>Bold</span>
          </div>
        </div>
      </Section>

      <Section id="together-h" title="Making decisions together">
        <div className="space-y-4">
          <Switch
            id="voting"
            checked={a.voting_enabled}
            onChange={(v) => set("voting_enabled", v)}
            label="Decide big purchases together"
            hint="When someone proposes something big, everyone in the household votes in the app and your assistant checks whether it fits the budget."
          />
          <Switch
            id="voice"
            checked={a.voice_consent}
            onChange={(v) => set("voice_consent", v)}
            label="Allow Table Mode (voice)"
            hint="Table Mode only listens after someone taps Start, shows a recording light the whole time, and deletes the transcript once it has pulled out your goals. You can turn it off any time."
          />
        </div>
      </Section>
      </div>

      {err ? (
        <div className="mt-5">
          <Notice tone="error">{err}</Notice>
        </div>
      ) : null}

      <StepFooter onBack={onBack}>
        <Button type="submit" size="lg" disabled={busy}>
          <BusyLabel busy={busy} busyText="Saving…">
            Save and finish
          </BusyLabel>
        </Button>
      </StepFooter>
    </form>
  );
}
