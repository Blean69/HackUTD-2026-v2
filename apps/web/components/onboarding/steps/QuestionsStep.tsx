"use client";
import { useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { IconPlus } from "@/components/icons";
import { Button } from "@/components/ui";
import { cx } from "@/lib/format";
import { useMembers } from "@/lib/data/hooks";
import {
  answerDefaults, defaultAnswers, friendlyError, GOAL_TEXT_MAX, MAX_PRIORITIES, onboarding, PRIORITIES, QUESTION_COUNT, RISK_LEVELS,
  type AccountOption, type HouseholdProfile, type OnboardingAnswers, type OnboardingBank,
} from "@/lib/data/onboarding";
import type { Member } from "@/lib/types";
import { BusyLabel, ChoiceRow, fieldCls, MoneyField, Notice, StepFooter, StepHeading } from "../fields";
import { SyncStatus } from "../SyncStatus";

// ------------------------------------------------------------------------------------------------ draft
// The three question screens share one draft, kept per household in memory and sessionStorage, so moving between
// screens (each is its own URL) or refreshing never loses an answer. Saved to the module once, on the last screen.

const drafts = new Map<string, OnboardingAnswers>();
const draftListeners = new Set<() => void>();
const KEY = (hid: string) => `onb.draft.${hid}`;

function readDraft(hid: string): OnboardingAnswers | undefined {
  if (drafts.has(hid)) return drafts.get(hid);
  try {
    const raw = sessionStorage.getItem(KEY(hid));
    if (raw) {
      const d = JSON.parse(raw) as OnboardingAnswers;
      drafts.set(hid, d);
      return d;
    }
  } catch {
    /* private mode */
  }
  return undefined;
}
function writeDraft(hid: string, d: OnboardingAnswers): void {
  drafts.set(hid, d);
  try {
    sessionStorage.setItem(KEY(hid), JSON.stringify(d));
  } catch {
    /* private mode: memory only */
  }
  for (const l of draftListeners) l();
}

function initial(profile: HouseholdProfile | undefined, people: readonly Member[], name: string, selected: AccountOption[]): OnboardingAnswers {
  const base = { ...defaultAnswers(name), ...answerDefaults(selected) };
  const saved = profile?.answers ?? {};
  const members = people.length
    ? people.map((m) => ({ id: m.id, name: m.name, role: m.role, age: m.age, income_annual: m.income_annual }))
    : saved.members?.length
      ? saved.members
      : base.members;
  return {
    members,
    own_home: saved.own_home ?? base.own_home,
    home_value: saved.home_value ?? base.home_value,
    vehicle_value: saved.vehicle_value ?? base.vehicle_value,
    priorities: saved.priorities ?? profile?.priorities ?? base.priorities,
    goal_text: saved.goal_text ?? "",
    risk_comfort: saved.risk_comfort ?? profile?.risk_comfort ?? base.risk_comfort,
    voting_enabled: saved.voting_enabled ?? true,
    voice_consent: saved.voice_consent ?? false,
  };
}

function useDraft(hid: string, init: () => OnboardingAnswers): [OnboardingAnswers, (patch: Partial<OnboardingAnswers>) => void] {
  const d = useSyncExternalStore(
    (cb) => {
      draftListeners.add(cb);
      return () => {
        draftListeners.delete(cb);
      };
    },
    () => readDraft(hid),
    () => undefined,
  );
  const value = d ?? init();
  return [value, (patch) => writeDraft(hid, { ...value, ...patch })];
}

// ------------------------------------------------------------------------------------------------ screens

function Goals({ a, set }: { a: OnboardingAnswers; set: (p: Partial<OnboardingAnswers>) => void }) {
  const [own, setOwn] = useState(a.goal_text.length > 0);
  const full = a.priorities.length >= MAX_PRIORITIES;
  const toggle = (key: string) =>
    set({ priorities: a.priorities.includes(key) ? a.priorities.filter((k) => k !== key) : full ? a.priorities : [...a.priorities, key] });
  return (
    <>
      <div role="group" aria-label="Priorities" className="flex flex-wrap gap-2">
        {PRIORITIES.map((p, i) => {
          const idx = a.priorities.indexOf(p.key);
          const on = idx >= 0;
          return (
            <button
              key={p.key}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => toggle(p.key)}
              className={cx(
                "press motion-fade inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-[0.9rem] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                on ? "border-brand bg-brand text-brand-ink" : "border-line-strong bg-surface text-ink hover:border-[#b5c2bb] hover:bg-surface-2",
              )}
              style={{ ["--i" as string]: i }}
            >
              {on ? (
                <span className="num motion-pop inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/25 text-[0.72rem]" aria-label={`priority ${idx + 1}`}>
                  {idx + 1}
                </span>
              ) : null}
              {p.label}
            </button>
          );
        })}
      </div>
      <p className="num mt-3 text-[0.82rem] text-ink-3" aria-live="polite">
        {a.priorities.length === 0 ? `Pick up to ${MAX_PRIORITIES}, most important first.` : full ? "That's three. Tap one to swap it out." : `${a.priorities.length} of ${MAX_PRIORITIES} picked.`}
      </p>
      <div className="mt-5">
        {own ? (
          <div>
            <label htmlFor="own-goal" className="mb-1.5 block text-[0.86rem] font-medium">
              Your own goal
            </label>
            <textarea
              id="own-goal"
              value={a.goal_text}
              onChange={(e) => set({ goal_text: e.target.value })}
              rows={2}
              maxLength={GOAL_TEXT_MAX}
              autoFocus
              placeholder="A second shop, a family trip, helping with a wedding"
              className={cx(fieldCls, "h-auto resize-none py-3 leading-snug")}
            />
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => setOwn(true)}>
            <IconPlus size={15} /> Add a goal in your own words
          </Button>
        )}
      </div>
    </>
  );
}

function Home({ a, set, est }: { a: OnboardingAnswers; set: (p: Partial<OnboardingAnswers>) => void; est: ReturnType<typeof answerDefaults> }) {
  return (
    <div className="space-y-5">
      <ChoiceRow
        name="housing"
        label="Do you own or rent your home?"
        value={a.own_home ? "own" : "rent"}
        onChange={(v) => set({ own_home: v === "own" })}
        options={[
          { value: "rent", label: "I rent" },
          { value: "own", label: "I own" },
        ]}
      />
      {a.own_home ? (
        <MoneyField
          id="home-value"
          label="About what is your home worth?"
          value={a.home_value}
          onChange={(n) => set({ home_value: n })}
          placeholder="350,000"
          hint={est.homeEstimated && a.home_value === est.home_value ? "Estimated from your mortgage. Adjust it if you know better." : "A ballpark is fine."}
        />
      ) : null}
      <MoneyField
        id="vehicle-value"
        label="About what are your vehicles worth?"
        value={a.vehicle_value}
        onChange={(n) => set({ vehicle_value: n })}
        placeholder="0"
        hint={est.vehicleEstimated && a.vehicle_value === est.vehicle_value ? "Estimated from your auto loan." : "All of them together. Leave it blank if you have none."}
      />
    </div>
  );
}

const RISK_SHORT = ["Safe", "Careful", "Balanced", "Growth", "Bold"];

function Comfort({ a, set }: { a: OnboardingAnswers; set: (p: Partial<OnboardingAnswers>) => void }) {
  const risk = RISK_LEVELS[a.risk_comfort - 1] ?? RISK_LEVELS[2];
  const income = a.members[0]?.income_annual ?? 0;
  return (
    <div className="space-y-6">
      <MoneyField
        id="income"
        label="Yearly household income, before taxes"
        value={income}
        onChange={(n) => set({ members: a.members.map((m, i) => (i === 0 ? { ...m, income_annual: n } : m)) })}
        placeholder="85,000"
        hint="Optional. Helps us check loan payments against what comes in."
      />
      <div>
        <p id="risk-h" className="mb-1.5 text-[0.86rem] font-medium">
          How do you feel about investment risk?
        </p>
        <ChoiceRow
          name="risk"
          label="Comfort with investment risk"
          value={a.risk_comfort}
          onChange={(v) => set({ risk_comfort: v })}
          options={RISK_LEVELS.map((r, i) => ({ value: r.value, label: <span className="text-[0.8rem] sm:text-[0.86rem]">{RISK_SHORT[i]}</span> }))}
        />
        <p className="mt-2 min-h-[2.5em] text-[0.84rem] leading-snug text-ink-2" aria-live="polite">
          <span className="font-semibold text-ink">{risk.label}.</span> {risk.hint}
        </p>
      </div>
    </div>
  );
}

const SCREENS: { title: string; sub: string }[] = [
  { title: "What are you working toward?", sub: "Your agents check each goal against your real accounts." },
  { title: "Your home and car", sub: "Used for your net worth. We filled in what we could from your accounts." },
  { title: "Last one: income and risk", sub: "Rough numbers are perfect. You can change any of this later." },
];

/** Step 5: three short screens, asked while the bank import runs in the background (`save_onboarding_answers`). */
export function QuestionsStep({
  householdId, q, bank, options, profile, defaultName, expectedTxns, onBack, onNext, onDone, headingRef,
}: {
  householdId: string;
  q: number;
  bank?: OnboardingBank;
  options: AccountOption[];
  profile?: HouseholdProfile;
  defaultName: string;
  expectedTxns?: number;
  onBack: () => void;
  onNext: (q: number) => void;
  onDone: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const people = useMembers(householdId);
  const selected = options.filter((o) => o.selected);
  const [a, set] = useDraft(householdId, () => initial(profile, people, defaultName, selected));
  const est = answerDefaults(selected);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const screen = q === 2 && !est.homeEstimated && !est.vehicleEstimated ? { ...SCREENS[1], sub: "Used for your net worth. A ballpark is fine." } : (SCREENS[q - 1] ?? SCREENS[0]);
  const last = q >= QUESTION_COUNT;

  async function submit() {
    if (!last) return onNext(q + 1);
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

  let body: ReactNode;
  if (q === 1) body = <Goals a={a} set={set} />;
  else if (q === 2) body = <Home a={a} set={set} est={est} />;
  else body = <Comfort a={a} set={set} />;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {bank && bank.status !== "selecting" ? (
        <div className="mb-6">
          <SyncStatus bank={bank} expectedAccounts={selected.length} expectedTxns={expectedTxns} compact />
        </div>
      ) : null}

      <StepHeading headingRef={headingRef} eyebrow={`Question ${q} of ${QUESTION_COUNT}`} title={screen.title} sub={screen.sub} />
      {body}

      {err ? (
        <div className="mt-5">
          <Notice tone="error">{err}</Notice>
        </div>
      ) : null}

      <StepFooter onBack={onBack}>
        <Button type="submit" size="lg" disabled={busy}>
          <BusyLabel busy={busy} busyText="Saving…">
            {last ? "Finish" : q === 1 && a.priorities.length === 0 && !a.goal_text.trim() ? "Skip" : "Next"}
          </BusyLabel>
        </Button>
      </StepFooter>
    </form>
  );
}
