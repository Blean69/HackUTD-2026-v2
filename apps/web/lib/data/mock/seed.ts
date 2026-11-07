/**
 * Synthetic data for the mock engine. Mirrors what data/generate.py puts in SpacetimeDB for the five seed
 * households (hh_rivera hero, hh_okafor, hh_nguyen elder-scam target, hh_patel messy data, hh_brooks).
 * No real people. Everything is invented.
 */
import type {
  Account, AccountType, Alert, BankConnection, Conversation, CreditProfile, Goal, Household, Member, MemberRole, Obligation,
} from "@/lib/types";
import { addDays, isoDate } from "./math";

export interface SeedHousehold {
  household: Household;
  members: Member[];
  accounts: Account[];
  obligations: Obligation[];
  credit: CreditProfile[];
  conversations: Conversation[];
  alerts: Alert[];
  goals: Goal[];
  banks?: BankConnection[];
  varSpend: number;
  nwTrend: number;
}

type AccOpts = { rate?: number; limit?: number; pay?: number; maturity?: string; opened?: string; owners?: string[] };

function mkAccount(hid: string, idx: number, type: AccountType, institution: string, nickname: string, balance: number, o: AccOpts = {}): Account {
  return {
    id: `acct_${hid.replace("hh_", "")}_${idx}`,
    household_id: hid,
    type,
    institution,
    nickname,
    balance,
    rate_pct: o.rate,
    credit_limit: o.limit,
    monthly_payment: o.pay,
    maturity_date: o.maturity,
    opened_date: o.opened ?? "2018-03-01",
    owner_member_ids: o.owners ?? [],
  };
}

function mkMember(hid: string, slug: string, name: string, age: number, role: MemberRole, income: number): Member {
  return { id: `mem_${hid.replace("hh_", "")}_${slug}`, household_id: hid, name, age, role, income_annual: income };
}

function mkOb(hid: string, idx: number, name: string, amount: number, due_day: number, kind: Obligation["kind"], accountId: string): Obligation {
  return { id: `obl_${hid.replace("hh_", "")}_${idx}`, household_id: hid, name, amount, due_day, account_id: accountId, kind };
}

function mkCredit(hid: string, m: Member, score: number, util: number, inq: number, yrs: number, late: number): CreditProfile {
  return { member_id: m.id, household_id: hid, score, utilization_pct: util, hard_inquiries_12m: inq, oldest_account_years: yrs, late_payments_24m: late };
}

function mkAlert(hid: string, n: number, severity: Alert["severity"], kind: Alert["kind"], title: string, detail: string, daysAgo: number, now: Date, related: string[] = []): Alert {
  return {
    id: `alert_${hid.replace("hh_", "")}_${n}`, household_id: hid, severity, kind, title, detail, related_ids: related,
    created_at: addDays(now, -daysAgo).toISOString(), acknowledged_by: "",
  };
}

function mkGoal(hid: string, n: number, g: Partial<Goal> & { title: string }, now: Date, daysAgo = 14): Goal {
  return {
    id: `goal_${hid.replace("hh_", "")}_${n}`, household_id: hid, priority: "medium", feasibility: "", source: "manual",
    created_at: addDays(now, -daysAgo).toISOString(), updated_at: addDays(now, -daysAgo).toISOString(), ...g,
  };
}

// ---------------------------------------------------------------------------------------------- Rivera

function rivera(now: Date): SeedHousehold {
  const hid = "hh_rivera";
  const marisol = mkMember(hid, "marisol", "Marisol Rivera", 42, "parent", 72000);
  const daniel = mkMember(hid, "daniel", "Daniel Rivera", 44, "parent", 58000);
  const sofia = mkMember(hid, "sofia", "Sofía Rivera", 16, "child", 0);
  const mateo = mkMember(hid, "mateo", "Mateo Rivera", 11, "child", 0);
  const lucia = mkMember(hid, "lucia", "Lucía Herrera", 68, "grandparent", 14400);
  const both = [marisol.id, daniel.id];
  const accounts = [
    mkAccount(hid, 1, "checking", "PNC", "Joint Checking", 4260.55, { owners: both, opened: "2014-06-02" }),
    mkAccount(hid, 2, "savings", "PNC", "Emergency Fund", 14300, { rate: 3.75, owners: both, opened: "2019-01-15" }),
    mkAccount(hid, 3, "savings", "PNC", "Kids' College Savings", 7250, { rate: 3.5, owners: [sofia.id, mateo.id], opened: "2020-08-20" }),
    mkAccount(hid, 4, "cd", "PNC", "12-month CD", 25000, { rate: 4.6, owners: both, maturity: isoDate(addDays(now, 125)), opened: isoDate(addDays(now, -240)) }),
    mkAccount(hid, 5, "ira", "PNC Investments", "Marisol IRA", 86400, { owners: [marisol.id], opened: "2011-04-10" }),
    mkAccount(hid, 6, "ira", "PNC Investments", "Daniel Roth IRA", 61200, { owners: [daniel.id], opened: "2013-02-18" }),
    mkAccount(hid, 7, "auto_loan", "PNC", "Honda Odyssey loan", 14820, { rate: 6.4, pay: 412, owners: both, opened: "2023-05-04" }),
    mkAccount(hid, 8, "personal_loan", "PNC", "Home improvement loan", 5900, { rate: 9.9, pay: 215, owners: both, opened: "2024-03-12" }),
    mkAccount(hid, 9, "credit_card", "PNC", "Cash Rewards Visa", 8140, { rate: 24.99, limit: 12000, pay: 400, owners: [marisol.id], opened: "2016-09-30" }),
    mkAccount(hid, 10, "credit_card", "Discover", "Discover it", 1150, { rate: 21.49, limit: 5000, pay: 60, owners: [daniel.id], opened: "2019-11-02" }),
    mkAccount(hid, 11, "mortgage", "PNC", "Oak Cliff home", 104200, { rate: 3.75, pay: 1420, owners: both, opened: "2014-06-20" }),
  ];
  const chk = accounts[0].id;
  const obligations = [
    mkOb(hid, 1, "Mortgage", 1420, 1, "loan", chk),
    mkOb(hid, 2, "St. Cecilia tuition (Mateo)", 625, 5, "tuition", chk),
    mkOb(hid, 3, "Honda Odyssey loan", 412, 8, "loan", chk),
    mkOb(hid, 4, "Streaming + apps", 64, 9, "subscription", chk),
    mkOb(hid, 5, "Home improvement loan", 215, 12, "loan", chk),
    mkOb(hid, 6, "Auto + home insurance", 238, 14, "insurance", chk),
    mkOb(hid, 7, "Visa payment", 400, 18, "bill", chk),
    mkOb(hid, 8, "Oncor electric", 186, 20, "bill", chk),
    mkOb(hid, 9, "Discover payment", 60, 21, "bill", chk),
    mkOb(hid, 10, "Internet + phones", 149, 22, "bill", chk),
    mkOb(hid, 11, "Dallas County property tax", 4380, 31, "tax", chk),
  ];
  const credit = [mkCredit(hid, marisol, 701, 68, 1, 14, 0), mkCredit(hid, daniel, 724, 23, 0, 11, 0)];
  const conversations: Conversation[] = [
    {
      id: "conv_rivera_1", household_id: hid, title: "Sunday dinner: the second location",
      scam_signals: [],
      turns: [
        { speaker: "Marisol", text: "Okay, family meeting. I want to talk about the Jackson Street space. The landlord wants an answer by January." },
        { speaker: "Daniel", text: "The one next to the laundromat? Marisol, that's a full build-out. Ovens, a hood, the walk-in cooler. Eighty-five thousand dollars, maybe more." },
        { speaker: "Marisol", text: "I know. But the line at Oak Cliff is out the door by seven every morning and we keep turning people away. I want to open a second location by June." },
        { speaker: "Lucía", text: "Mija, and who watches the kids when you are at two bakeries?" },
        { speaker: "Marisol", text: "Mamá, that's exactly why we're talking about it together. I also want to start a college fund for Sofía. She starts applying in two years." },
        { speaker: "Sofía", text: "Mom, I can work Saturdays at the counter." },
        { speaker: "Daniel", text: "Honestly the Visa has me nervous. We're carrying eight thousand on that card at twenty-five percent. I want it paid off before we borrow anything. Say by March." },
        { speaker: "Marisol", text: "Fine, pay off the Visa first. And I want a real emergency fund, six months of expenses, before we sign any lease." },
        { speaker: "Daniel", text: "And Mamá's blood pressure medicine and the cardiologist. We should set aside something every month for her care, maybe three hundred." },
        { speaker: "Lucía", text: "I don't want to be a burden to you." },
        { speaker: "Marisol", text: "You're not. Okay: second location by June, Visa gone by March, college fund started, and a care fund for Mamá. Let's see if the numbers work." },
      ],
      expected_goals: [
        { title: "Open a second bakery location", target_amount: 85000, target_date: "2027-06-30", priority: "high", feasibility: "stretch" },
        { title: "Pay off the Visa", target_amount: 8140, target_date: "2027-03-31", priority: "high", feasibility: "on_track" },
      ],
    },
    {
      id: "conv_rivera_2", household_id: hid, title: "Mamá got a strange phone call",
      scam_signals: ["tech-support impersonation", "gift cards", "urgency", "remote access request"],
      turns: [
        { speaker: "Lucía", text: "A man called me from Microsoft support. He said my computer was sending viruses and I had to fix it today or they would block my bank account." },
        { speaker: "Daniel", text: "Mamá, did you give him anything?" },
        { speaker: "Lucía", text: "He asked me to install a program so he could look at the computer. And he said to buy gift cards at the pharmacy, two cards, five hundred dollars each, and read him the numbers." },
        { speaker: "Marisol", text: "Mamá, please tell me you didn't." },
        { speaker: "Lucía", text: "I bought one already. He said not to tell anyone or the account would be frozen immediately." },
        { speaker: "Daniel", text: "That's a scam. We need to call the bank right now and freeze that gift card." },
      ],
      expected_goals: [{ title: "Protect Mamá's accounts from scams", priority: "high", feasibility: "on_track" }],
    },
    {
      id: "conv_rivera_3", household_id: hid, title: "The delivery van and the tuition bump",
      scam_signals: [],
      turns: [
        { speaker: "Daniel", text: "The van is done. The transmission quote is four grand and it's worth less than that. I want to buy a used delivery van, around $32,000, by March." },
        { speaker: "Marisol", text: "Before the property tax bill? That lands January thirty-first, four thousand three hundred and eighty dollars." },
        { speaker: "Daniel", text: "I know. That's why I'm asking. Can we afford it or not?" },
        { speaker: "Marisol", text: "Let's make a vacation fund too. Maybe $4,500 for a trip to Monterrey next summer. The kids have never been." },
      ],
      expected_goals: [{ title: "Buy a used delivery van", target_amount: 32000, target_date: "2027-03-31", priority: "medium", feasibility: "stretch" }],
    },
  ];
  const alerts = [
    mkAlert(hid, 1, "critical", "fraud", "Possible card testing on your Visa ••4417",
      "Three charges under $2 from unfamiliar online merchants landed within 4 minutes on Oct 29, followed by a declined $412 attempt. This is a classic card-testing pattern. Lock the card and request a new one.", 9, now, ["txn_riv_9001", "txn_riv_9002", "txn_riv_9003"]),
    mkAlert(hid, 2, "warn", "obligation", "Property tax lands Jan 31 and cuts checking close to zero",
      "The $4,380 Dallas County bill arrives the day before payday. Moving about $1,500 from savings before then keeps you out of overdraft.", 2, now, ["obl_rivera_11"]),
    mkAlert(hid, 3, "warn", "data_quality", "Oncor electric bill posted twice on Oct 21",
      "Two identical $186.40 debits from Oncor posted one minute apart. One is likely a duplicate; dispute it or confirm.", 17, now, ["txn_riv_7001", "txn_riv_7002"]),
    mkAlert(hid, 4, "info", "data_quality", "2 transactions have unreadable merchant names",
      "Descriptions like \"SQ *#PAN3RIA TX\" could not be matched to a merchant. They were categorised as Dining by best guess.", 21, now, ["txn_riv_7101", "txn_riv_7102"]),
  ];
  const goals = [
    mkGoal(hid, 1, { title: "Repaint the bakery storefront", target_amount: 2400, target_date: isoDate(addDays(now, 120)), priority: "low", feasibility: "on_track" }, now, 30),
  ];
  return {
    household: { id: hid, name: "The Rivera Household", city: "Dallas", state: "TX", persona: "Marisol and Daniel run Rivera's Panadería in Oak Cliff. Two kids, plus Marisol's mother Lucía lives with them.", template_id: "", created_at: addDays(now, -400).toISOString() },
    members: [marisol, daniel, sofia, mateo, lucia], accounts, obligations, credit, conversations, alerts, goals, varSpend: 4600, nwTrend: 6.4,
  };
}

// ---------------------------------------------------------------------------------------------- Okafor

function okafor(now: Date): SeedHousehold {
  const hid = "hh_okafor";
  const chidi = mkMember(hid, "chidi", "Chidi Okafor", 35, "parent", 118000);
  const ngozi = mkMember(hid, "ngozi", "Ngozi Okafor", 33, "parent", 96000);
  const amara = mkMember(hid, "amara", "Amara Okafor", 1, "child", 0);
  const both = [chidi.id, ngozi.id];
  const accounts = [
    mkAccount(hid, 1, "checking", "PNC", "Everyday Checking", 9800, { owners: both }),
    mkAccount(hid, 2, "savings", "PNC", "Rainy Day", 22000, { rate: 3.75, owners: both }),
    mkAccount(hid, 3, "cd", "PNC", "18-month CD", 20000, { rate: 4.9, maturity: isoDate(addDays(now, 210)), owners: both }),
    mkAccount(hid, 4, "ira", "PNC Investments", "Chidi rollover IRA", 191000, { owners: [chidi.id] }),
    mkAccount(hid, 5, "ira", "PNC Investments", "Ngozi IRA", 112000, { owners: [ngozi.id] }),
    mkAccount(hid, 6, "personal_loan", "Nelnet", "Student loans", 38400, { rate: 5.8, pay: 520, owners: [chidi.id] }),
    mkAccount(hid, 7, "auto_loan", "PNC", "Toyota Highlander", 18900, { rate: 5.9, pay: 465, owners: both }),
    mkAccount(hid, 8, "credit_card", "PNC", "Cash Unlimited Visa", 2100, { rate: 21.99, limit: 14000, pay: 150, owners: both }),
    mkAccount(hid, 9, "mortgage", "PNC", "Sugar Land home", 168000, { rate: 6.1, pay: 2145, owners: both }),
  ];
  const chk = accounts[0].id;
  const obligations = [
    mkOb(hid, 1, "Mortgage", 2145, 1, "loan", chk), mkOb(hid, 2, "Student loans", 520, 6, "loan", chk),
    mkOb(hid, 3, "Highlander loan", 465, 10, "loan", chk), mkOb(hid, 4, "Daycare", 1350, 3, "bill", chk),
    mkOb(hid, 5, "Insurance bundle", 310, 14, "insurance", chk), mkOb(hid, 6, "Utilities + internet", 360, 19, "bill", chk),
  ];
  return {
    household: { id: hid, name: "The Okafor Household", city: "Sugar Land", state: "TX", persona: "Dual-income professionals with a new baby, attacking student loans.", template_id: "", created_at: addDays(now, -300).toISOString() },
    members: [chidi, ngozi, amara], accounts, obligations,
    credit: [mkCredit(hid, chidi, 762, 15, 0, 12, 0), mkCredit(hid, ngozi, 748, 12, 1, 9, 0)],
    conversations: [{
      id: "conv_okafor_1", household_id: hid, title: "Daycare vs. paying off the loans", scam_signals: [],
      turns: [
        { speaker: "Chidi", text: "I'd like the student loans gone by 2029. That's $38,400 and it's still at 5.8 percent." },
        { speaker: "Ngozi", text: "Daycare is $1,350 a month right now. Can we also build a college fund for Amara?" },
      ],
      expected_goals: [{ title: "Pay off student loans", target_amount: 38400, target_date: "2029-06-30", priority: "high" }],
    }],
    alerts: [mkAlert(hid, 1, "info", "obligation", "CD matures in 7 months", "Your 18-month CD ($20,000 at 4.9%) matures soon. Decide whether to roll it over or put it toward the student loans.", 5, now)],
    goals: [mkGoal(hid, 1, { title: "Pay off student loans", target_amount: 38400, target_date: "2029-06-30", priority: "high", feasibility: "on_track" }, now, 40)],
    varSpend: 4800, nwTrend: 9.2,
  };
}

// ---------------------------------------------------------------------------------------------- Nguyen (elder scam)

function nguyen(now: Date): SeedHousehold {
  const hid = "hh_nguyen";
  const binh = mkMember(hid, "binh", "Bình Nguyen", 74, "grandparent", 45600);
  const lan = mkMember(hid, "lan", "Lan Nguyen", 72, "grandparent", 18000);
  const kevin = mkMember(hid, "kevin", "Kevin Nguyen", 19, "other", 0);
  const both = [binh.id, lan.id];
  const accounts = [
    mkAccount(hid, 1, "checking", "PNC", "Everyday Checking", 5240, { owners: both }),
    mkAccount(hid, 2, "savings", "PNC", "Savings", 31500, { rate: 3.5, owners: both }),
    mkAccount(hid, 3, "cd", "PNC", "24-month CD", 40000, { rate: 4.4, maturity: isoDate(addDays(now, 60)), owners: both }),
    mkAccount(hid, 4, "ira", "PNC Investments", "Bình IRA", 112000, { owners: [binh.id] }),
    mkAccount(hid, 5, "credit_card", "PNC", "Points Visa", 640, { rate: 19.99, limit: 8000, pay: 120, owners: both }),
  ];
  const chk = accounts[0].id;
  const obligations = [
    mkOb(hid, 1, "Property tax escrow + HOA", 410, 1, "bill", chk), mkOb(hid, 2, "Medicare supplement", 245, 5, "insurance", chk),
    mkOb(hid, 3, "Utilities", 230, 18, "bill", chk), mkOb(hid, 4, "Phone + internet", 120, 22, "bill", chk),
  ];
  return {
    household: { id: hid, name: "The Nguyen Household", city: "Garland", state: "TX", persona: "Retired couple on fixed income; grandson Kevin visits weekends. Target of a 'grandson in jail' call.", template_id: "", created_at: addDays(now, -500).toISOString() },
    members: [binh, lan, kevin], accounts, obligations,
    credit: [mkCredit(hid, binh, 790, 8, 0, 40, 0), mkCredit(hid, lan, 783, 8, 0, 38, 0)],
    conversations: [{
      id: "conv_nguyen_1", household_id: hid, title: "The call from 'Kevin'", scam_signals: ["grandparent impersonation", "bail money", "gift cards", "secrecy"],
      turns: [
        { speaker: "Lan", text: "Someone called saying he was Kevin. He said he was in jail after a car accident and needed bail money right away." },
        { speaker: "Bình", text: "He said not to tell his parents. A lawyer called after and asked for $2,000 in gift cards." },
        { speaker: "Lan", text: "I bought them this morning at the pharmacy. Then Kevin walked in the door and said he never called." },
      ],
      expected_goals: [],
    }],
    alerts: [
      mkAlert(hid, 1, "critical", "scam", "Possible 'grandson in jail' scam linked to a $2,000 gift-card purchase",
        "A call claiming to be Kevin (bail request, secrecy) was followed 40 minutes later by $2,000 in gift-card purchases at a pharmacy. This matches the grandparent-scam pattern. Report the cards to the issuer now.", 1, now, ["txn_ngu_5001"]),
      mkAlert(hid, 2, "info", "obligation", "24-month CD matures in 60 days", "$40,000 at 4.4% matures soon. A trusted family member can be added to review any large transfer.", 6, now),
    ],
    goals: [mkGoal(hid, 1, { title: "Replace the roof", target_amount: 14000, target_date: isoDate(addDays(now, 300)), priority: "medium", feasibility: "on_track" }, now, 25)],
    varSpend: 2100, nwTrend: 3.1,
  };
}

// ---------------------------------------------------------------------------------------------- Patel (messy data)

function patel(now: Date): SeedHousehold {
  const hid = "hh_patel";
  const raj = mkMember(hid, "raj", "Raj Patel", 41, "parent", 104000);
  const meera = mkMember(hid, "meera", "Meera Patel", 39, "parent", 71000);
  const dev = mkMember(hid, "dev", "Dev Patel", 9, "child", 0);
  const anika = mkMember(hid, "anika", "Anika Patel", 6, "child", 0);
  const both = [raj.id, meera.id];
  const accounts = [
    mkAccount(hid, 1, "checking", "PNC", "Main Checking", 3120, { owners: both }),
    mkAccount(hid, 2, "checking", "Chase", "Meera's Checking", 1480, { owners: [meera.id] }),
    mkAccount(hid, 3, "savings", "Ally", "Vacation Savings", 5200, { rate: 4.0, owners: both }),
    mkAccount(hid, 4, "ira", "PNC Investments", "Raj IRA", 178000, { owners: [raj.id] }),
    mkAccount(hid, 5, "auto_loan", "PNC", "Pilot SUV loan", 24700, { rate: 7.2, pay: 540, owners: both }),
    mkAccount(hid, 6, "credit_card", "PNC", "Visa", 9400, { rate: 23.99, limit: 11000, pay: 300, owners: [raj.id] }),
    mkAccount(hid, 7, "credit_card", "Chase", "Sapphire", 6700, { rate: 22.49, limit: 9000, pay: 220, owners: [meera.id] }),
    mkAccount(hid, 8, "credit_card", "Amex", "Blue Cash", 5100, { rate: 20.99, limit: 6000, pay: 180, owners: both }),
    mkAccount(hid, 9, "mortgage", "PNC", "Plano home", 161000, { rate: 6.4, pay: 2610, owners: both }),
  ];
  const chk = accounts[0].id;
  const obligations = [
    mkOb(hid, 1, "Mortgage", 2610, 1, "loan", chk), mkOb(hid, 2, "Pilot loan", 540, 7, "loan", chk),
    mkOb(hid, 3, "Card minimums", 700, 15, "bill", chk), mkOb(hid, 4, "Utilities", 420, 19, "bill", chk),
    mkOb(hid, 5, "Kids' activities", 380, 3, "bill", chk),
  ];
  return {
    household: { id: hid, name: "The Patel Household", city: "Plano", state: "TX", persona: "Accounts spread over three banks with messy, duplicated and garbled transaction data.", template_id: "", created_at: addDays(now, -200).toISOString() },
    members: [raj, meera, dev, anika], accounts, obligations,
    credit: [mkCredit(hid, raj, 668, 85, 3, 15, 1), mkCredit(hid, meera, 681, 74, 2, 12, 0)],
    conversations: [{
      id: "conv_patel_1", household_id: hid, title: "Why is there never any money left", scam_signals: [],
      turns: [
        { speaker: "Raj", text: "We have three credit cards near the limit. I want to pay down the cards before we buy anything else." },
        { speaker: "Meera", text: "And I want an emergency fund. We have maybe a month of cushion." },
      ],
      expected_goals: [],
    }],
    alerts: [
      mkAlert(hid, 1, "warn", "data_quality", "12 duplicate transactions across Chase and PNC imports", "The same Costco and Shell purchases appear in two feeds. Balances may be understated by about $640.", 3, now),
      mkAlert(hid, 2, "warn", "data_quality", "A -$1,000,000.00 deposit looks like an import error", "One Ally transaction has an impossible amount and was excluded from totals until you confirm it.", 4, now),
      mkAlert(hid, 3, "info", "data_quality", "6 merchants could not be read", "Garbled descriptions such as \"AMZN MKTP U*#8$2\" were left uncategorised.", 6, now),
    ],
    goals: [],
    varSpend: 5600, nwTrend: -1.1,
  };
}

// ---------------------------------------------------------------------------------------------- Brooks

function brooks(now: Date): SeedHousehold {
  const hid = "hh_brooks";
  const jordan = mkMember(hid, "jordan", "Jordan Brooks", 29, "parent", 82000);
  const taylor = mkMember(hid, "taylor", "Taylor Brooks", 28, "parent", 74000);
  const both = [jordan.id, taylor.id];
  const accounts = [
    mkAccount(hid, 1, "checking", "PNC", "Virtual Wallet Spend", 3100, { owners: both }),
    mkAccount(hid, 2, "savings", "PNC", "Home Down Payment", 14200, { rate: 3.75, owners: both }),
    mkAccount(hid, 3, "cd", "PNC", "12-month CD", 10000, { rate: 4.7, maturity: isoDate(addDays(now, 150)), owners: both }),
    mkAccount(hid, 4, "ira", "PNC Investments", "Jordan Roth IRA", 11800, { owners: [jordan.id] }),
    mkAccount(hid, 5, "auto_loan", "PNC", "Civic loan", 12400, { rate: 5.4, pay: 335, owners: [taylor.id] }),
    mkAccount(hid, 6, "credit_card", "PNC", "Cash Rewards Visa", 1900, { rate: 22.99, limit: 6000, pay: 200, owners: both }),
    { ...mkAccount(hid, 7, "checking", "First Platypus Bank", "Plaid Checking", 110.0, { owners: both }), id: "acct_plaid_brooks_chk", source: "plaid" as const },
    { ...mkAccount(hid, 8, "savings", "First Platypus Bank", "Plaid Saving", 210.0, { rate: 0.1, owners: both }), id: "acct_plaid_brooks_sav", source: "plaid" as const },
  ];
  const chk = accounts[0].id;
  const obligations = [
    mkOb(hid, 1, "Rent", 1850, 1, "bill", chk), mkOb(hid, 2, "Civic loan", 335, 9, "loan", chk),
    mkOb(hid, 3, "Renters + auto insurance", 190, 12, "insurance", chk), mkOb(hid, 4, "Utilities + phones", 260, 20, "bill", chk),
    mkOb(hid, 5, "Gym + streaming", 85, 6, "subscription", chk),
  ];
  return {
    household: { id: hid, name: "The Brooks Household", city: "Fort Worth", state: "TX", persona: "Young couple saving for a first home.", template_id: "", created_at: addDays(now, -120).toISOString() },
    members: [jordan, taylor], accounts, obligations,
    credit: [mkCredit(hid, jordan, 735, 28, 1, 8, 0), mkCredit(hid, taylor, 712, 33, 2, 7, 0)],
    conversations: [{
      id: "conv_brooks_1", household_id: hid, title: "House hunting numbers", scam_signals: [],
      turns: [
        { speaker: "Jordan", text: "I want to save a $40,000 down payment by the end of 2028." },
        { speaker: "Taylor", text: "Then let's get the Visa paid off first and keep building the emergency fund." },
      ],
      expected_goals: [{ title: "Save a home down payment", target_amount: 40000, target_date: "2028-12-31", priority: "high" }],
    }],
    banks: [{ item_id: "item_brooks_1", household_id: hid, institution_name: "First Platypus Bank", status: "ok", accounts_count: 2, txns_count: 184, last_synced_at: addDays(now, -1).toISOString() }],
    alerts: [mkAlert(hid, 1, "info", "obligation", "Rent increases $75 in January", "Your lease renews at $1,925. Your forecast still stays above $1,500.", 8, now)],
    goals: [mkGoal(hid, 1, { title: "Save a home down payment", target_amount: 40000, target_date: "2028-12-31", priority: "high", feasibility: "stretch" }, now, 60)],
    varSpend: 3300, nwTrend: 11.8,
  };
}

export function buildSeed(now: Date): SeedHousehold[] {
  return [rivera(now), okafor(now), nguyen(now), patel(now), brooks(now)];
}
