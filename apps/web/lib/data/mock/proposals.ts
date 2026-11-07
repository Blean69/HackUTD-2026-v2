/**
 * Family voting, client side (contracts.md section 6).
 *
 * Two jobs:
 *  1. Seed a few demo proposals + votes for the five seed households (the mock engine, and the live backend while
 *     the module has no `proposal` / `vote` tables yet).
 *  2. `createLocalProposalActions`: create_proposal / cast_vote / close_proposal against the in-memory store, with a
 *     deterministic "quick check" verdict in place of the agent. The mock engine overrides create with a scripted
 *     what_if agent run; the live backend uses the real reducers as soon as the bindings have them.
 */
import { LIABILITY_TYPES, usd } from "@/lib/format";
import type { Account, Proposal, ProposalAnalysis, ProposalDetails, ProposalVerdict, Vote, VoteChoice } from "@/lib/types";
import type { DataStore } from "../store";
import { addDays } from "./math";

const DAY = 86_400_000;

interface SeedSpec {
  title: string;
  amount: number;
  details: ProposalDetails;
  by: string;
  createdDaysAgo: number;
  closesInDays: number;
  verdict: ProposalVerdict;
  summary: string;
  votes: [memberSlug: string, choice: VoteChoice][];
  status?: "open" | "closed";
}

const SEEDS: Record<string, SeedSpec[]> = {
  hh_rivera: [
    {
      title: "Buy a used minivan", amount: 35000, details: { down_pct: 20, term_months: 60, rate_pct: 6.2 }, by: "Marisol", createdDaysAgo: 2, closesInDays: 3,
      verdict: "tight",
      summary: "A $7,000 down payment leaves about $28,000 financed at 6.2% for 60 months, roughly $545 a month. Checking dips under the $1,500 buffer in early January, right before the property tax bill.",
      votes: [["marisol", "yes"], ["daniel", "yes"], ["lucia", "abstain"]],
    },
    {
      title: "Replace the walk-in cooler compressor", amount: 4800, details: {}, by: "Daniel", createdDaysAgo: 12, closesInDays: -4, verdict: "fine",
      summary: "Paying $4,800 from the Emergency Fund keeps the 90-day low point above $9,000. No financing needed.",
      votes: [["marisol", "yes"], ["daniel", "yes"], ["lucia", "yes"]], status: "closed",
    },
  ],
  hh_okafor: [
    { title: "Family trip to Lagos", amount: 6500, details: {}, by: "Chidi", createdDaysAgo: 1, closesInDays: 6, verdict: "fine", summary: "Six thousand five hundred dollars is covered by the travel savings with room to spare; the 90-day cash low point stays comfortable.", votes: [["chidi", "yes"]] },
  ],
  hh_nguyen: [
    { title: "Walk-in shower for the hall bath", amount: 11000, details: {}, by: "Lan", createdDaysAgo: 3, closesInDays: 4, verdict: "tight", summary: "The savings account covers it, but it would use about a third of the cushion that backs the monthly medical costs.", votes: [["lan", "yes"], ["binh", "abstain"]] },
  ],
  hh_patel: [
    { title: "Pay down the Visa with savings", amount: 5000, details: {}, by: "Meera", createdDaysAgo: 2, closesInDays: 5, verdict: "risky", summary: "Using $5,000 of savings would leave about 3 weeks of cash cover. Paying the card helps utilization, but the buffer would be thin.", votes: [["raj", "no"], ["meera", "yes"]] },
  ],
  hh_brooks: [
    { title: "Used Honda CR-V", amount: 22000, details: { down_pct: 15, term_months: 60, rate_pct: 7.1 }, by: "Taylor", createdDaysAgo: 1, closesInDays: 6, verdict: "risky", summary: "A second car loan adds about $370 a month and pushes debt-to-income past 36%. It would also slow the home down-payment goal by roughly 8 months.", votes: [["taylor", "yes"], ["jordan", "no"]] },
  ],
};

const VOTER_NAME: Record<string, string> = { lucia: "Lucía", binh: "Bình" };

/** Demo proposals and seeded votes (voter_key = member id, as in data/seed/votes.json). */
export function seedProposals(now: Date, households: readonly string[]): { proposals: Proposal[]; votes: Vote[] } {
  const proposals: Proposal[] = [];
  const votes: Vote[] = [];
  for (const hid of households) {
    const specs = SEEDS[hid];
    if (!specs) continue;
    specs.forEach((s, i) => {
      const id = `prop_${hid.replace("hh_", "")}_${i + 1}`;
      const closes = new Date(now.getTime() + s.closesInDays * DAY);
      proposals.push({
        id, household_id: hid, title: s.title, amount: s.amount, details: s.details, created_by_name: s.by,
        created_at: addDays(now, -s.createdDaysAgo).toISOString(), closes_at: closes.toISOString(),
        status: s.status ?? (s.closesInDays > 0 ? "open" : "closed"), verdict: s.verdict,
        analysis: { summary: s.summary }, run_id: "",
      });
      for (const [slug, choice] of s.votes) {
        const memberId = `mem_${hid.replace("hh_", "")}_${slug}`;
        votes.push({ id: `${id}:${memberId}`, proposal_id: id, household_id: hid, voter_key: memberId, voter_name: VOTER_NAME[slug] ?? slug[0].toUpperCase() + slug.slice(1), choice, updated_at: addDays(now, -1).toISOString() });
      }
    });
  }
  return { proposals, votes };
}

/** A transparent, deterministic stand-in for the agent: cash on hand vs the cost (and financing). */
export function quickVerdict(amount: number, details: ProposalDetails, accounts: readonly Account[]): { verdict: ProposalVerdict; analysis: ProposalAnalysis } {
  const liquid = accounts.filter((a) => a.type === "checking" || a.type === "savings").reduce((s, a) => s + a.balance, 0);
  const debt = accounts.filter((a) => LIABILITY_TYPES.has(a.type)).reduce((s, a) => s + a.balance, 0);
  const down = details.down_pct !== undefined ? (amount * details.down_pct) / 100 : amount;
  const financed = amount - down;
  const months = details.term_months ?? 0;
  const r = (details.rate_pct ?? 0) / 100 / 12;
  const monthly = financed > 0 && months > 0 ? (r === 0 ? financed / months : (financed * r) / (1 - Math.pow(1 + r, -months))) : 0;
  const after = liquid - down;
  const ratio = liquid > 0 ? after / liquid : -1;
  const verdict: ProposalVerdict = after < 0 ? "risky" : ratio < 0.35 || monthly > 600 ? "risky" : ratio < 0.65 || monthly > 350 ? "tight" : "fine";
  const summary =
    `${down > 0 ? `${usd(down)} up front` : "No cash up front"}${financed > 0 ? `, ${usd(financed)} financed${monthly ? ` (about ${usd(monthly)} a month)` : ""}` : ""}. ` +
    `Checking and savings would go from ${usd(liquid)} to ${usd(after)}${debt ? `, with ${usd(debt)} of existing debt` : ""}. Quick estimate, not an agent run.`;
  return { verdict, analysis: { summary, metrics: [{ label: "Cash after purchase", before: liquid, after, unit: "usd" }] } };
}

export interface ProposalActions {
  createProposal(input: { householdId: string; title: string; amount: number; details: ProposalDetails; closesInDays: number; authorName: string }): Promise<string>;
  castVote(proposalId: string, choice: VoteChoice, voterName: string): Promise<void>;
  closeProposal(proposalId: string): Promise<void>;
}

export function createLocalProposalActions(store: DataStore, me: () => string, afterCreate?: (p: Proposal) => void): ProposalActions {
  return {
    createProposal: async ({ householdId, title, amount, details, closesInDays, authorName }) => {
      const now = new Date();
      const id = `prop_${Math.random().toString(36).slice(2, 8)}`;
      const accounts = store.rows("account").filter((a) => a.household_id === householdId);
      const q = quickVerdict(amount, details, accounts);
      const p: Proposal = {
        id, household_id: householdId, title, amount, details, created_by_name: authorName, created_at: now.toISOString(),
        closes_at: new Date(now.getTime() + closesInDays * DAY).toISOString(), status: "open", verdict: afterCreate ? "" : q.verdict,
        analysis: afterCreate ? undefined : q.analysis, run_id: "",
      };
      store.upsert("proposal", p);
      afterCreate?.(p);
      return id;
    },
    castVote: async (proposalId, choice, voterName) => {
      const p = store.get("proposal", proposalId);
      if (!p) throw new Error("That proposal no longer exists.");
      if (p.status !== "open" || new Date(p.closes_at).getTime() < Date.now()) throw new Error("Voting has closed on this proposal.");
      const key = me();
      store.upsert("vote", { id: `${proposalId}:${key}`, proposal_id: proposalId, household_id: p.household_id, voter_key: key, voter_name: voterName, choice, updated_at: new Date().toISOString() });
    },
    closeProposal: async (proposalId) => {
      store.patch("proposal", proposalId, { status: "closed" });
    },
  };
}
