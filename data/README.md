# Keystone synthetic data (household side)

Seeded, deterministic, standard-library-only generator for the five demo households. **All data is synthetic**: names,
merchants' store numbers, phone numbers (555-01xx) and amounts are invented.

```bash
cd data
python3 generate.py                 # --seed 2026 by default, writes data/seed/*.json (about 0.73 MB)
python3 generate.py --seed 7 --out /tmp/other   # any seed works; ids below are for seed 2026 only
python3 generate.py --report        # also prints every planted anomaly (txn ids) and every balance
```

Python 3.12 to 3.14, no third-party packages (`requirements.txt` is intentionally empty). The same seed gives
byte-identical files (verified across runs and `PYTHONHASHSEED`). `generate.py` asserts the invariants listed at the
bottom of this file, so a bad edit fails loudly.

| File | Rows | Notes |
|---|---:|---|
| `households.json` | 5 | `id, name, city, state, persona, home_value, vehicle_value` |
| `members.json` | 15 | |
| `accounts.json` | 35 | all 8 account types |
| `transactions.json` | 2,918 | 2026-05-09 .. 2026-11-06, one JSON object per line |
| `credit_profiles.json` | 11 | adults only; `utilization_pct` is computed from the card accounts |
| `obligations.json` | 71 | |
| `conversations.json` | 6 | 24, 22, 22, 22, 16 and 26 turns |
| `proposals.json` | 5 | one open Family-voting proposal per household (see "Family voting" below) |
| `votes.json` | 12 | seeded votes from household members (`voter_key` = member id) |

Every record is flat (scalars, plus `owner_member_ids: string[]` on accounts, `turns`, `expected_goals`,
`scam_signals` on conversations, and the free-form `details` object on proposals). Ids are strings, dates are ISO `YYYY-MM-DD`, money is a JSON number in USD.

## Conventions you need to know (read before writing the loader or the math)

* **Net worth by household (seed 2026):**

  | Household | Deposits + IRA | home_value | vehicle_value | Debts | **Net worth** |
  |---|---:|---:|---:|---:|---:|
  | `hh_rivera` | $158,509 | $410,000 | $47,000 | $270,709 | **+$344,800** (mortgage $247.3k = 60% of home value) |
  | `hh_okafor` | $25,243 | 0 (renters) | $19,500 | $86,350 | **-$41,607** (student loans + card debt) |
  | `hh_nguyen` | $662,521 | $285,000 (paid off) | $22,000 | $118 | **+$969,403** |
  | `hh_patel` | $377 | 0 (renter) | $8,900 | $10,600 | **-$1,323** |
  | `hh_brooks` | $107,279 | $330,000 | $45,000 | $222,758 | **+$259,521** (mortgage $198.4k = 60% of home value) |

* **Debt accounts** (`credit_card`, `auto_loan`, `personal_loan`, `mortgage`): `balance` is the **positive amount owed**.
  Deposit accounts (`checking`, `savings`, `cd`, `ira`): `balance` is what the household has. Net worth = checking + savings + cd + ira + `home_value` + `vehicle_value` minus debt balances
  (contracts.md). `home_value` is 0 for renters (Okafor, Patel); owners' mortgages sit well below it.
* `Transaction.amount` is negative when money leaves that account / a charge is made. On a debt account a **positive**
  amount is a payment received. Card and loan payments appear on both sides (`credit_card_payment` / `loan_payment`
  categories; savings and IRA moves use `transfer` / `savings`), so exclude `transfer`, `savings`, `credit_card_payment`
  and the loan-account side when you compute spending.
* `is_recurring = true` marks things a forecast should project: payroll, Social Security, pension, bills, loan and card
  payments, subscriptions, automatic transfers. Bakery owner draws, gig payouts and child support are deliberately
  `false` (lumpy). Weekly after-school care (Patel) is recurring weekly; its obligation is the monthly equivalent.
* **Balances reconcile.** For every account: `balance = opening balance + sum(amount)` over all rows **except**
  `duplicate` and `impossible_value` rows, which are import artefacts and are not part of the true balance. All other
  labelled rows (garbled, card testing, account takeover, scam, outlier) are real money movements.
* `Transaction.anomaly` is ground truth and is **omitted** when empty. Rows also carry an additive `household_id`
  and `credit_profiles.json` rows an additive `household_id` (handy for the loader; ignore them if you derive it).
* `Obligation.account_id` is the account the money is **paid from** (the household's checking account in every case);
  loan and card obligations are included (kind `loan`) so obligations are the complete list of cash outflows the
  forecast should apply. `Account.monthly_payment` is informational (display and debt-to-income). Subscription bills
  are on checking so they are not double counted with card payments.
* `Member.role`: adults in a household without kids are `other` (Okafor), retirees are `grandparent` (Nguyen), the rest
  follow the contract. `Account.rate_pct` is APY for deposits and APR for debt; IRAs have none. Merchants are real
  national or Texas brands (Kroger, QuikTrip, H-E-B) for realism; banks, employers and local shops are fictional.
* Today is **2026-11-07**. The window is 2026-05-09 .. 2026-11-06. The only rows dated after 2026-11-06 are the
  planted `impossible_value` rows.

## The households

| Household | Who | Accounts (8 types covered across all five) | Story |
|---|---|---|---|
| `hh_rivera` (hero, clean) | Marisol 38 (bakery owner, $72k draws), Daniel 41 ($84k), Sofia 15, Mateo 9, Elena 68 (Marisol's mother, Social Security) | joint checking $4,409, emergency savings $14,200, college fund $21,500, Daniel's IRA $118,400, mortgage $247,300 (3.875%), F-150 loan $19,800, two cards (about 10% and 26% utilization). **Six institutions.** | Financially solid, lumpy cash. Owner draws arrive every 7 to 16 days in amounts from $600 to $4,200, plus $6.2k and $7.4k quarterly distributions (Jul 2, Oct 2); estimated tax $4,800 on Jun 15 and Sep 15. No planted fraud. One benign **outlier**: Elena's $3,412.18 hospital bill (Sep 24). The bakery is context only (no commercial entity). |
| `hh_okafor` | Amara 28 (RN, $74k), Chidi 29 (QA engineer, $68k), renting in Lakewood | checking, House Fund savings $22,300, two cards (Amara's $8k card at **86% utilization**, Chidi's $5k store card 61%), two student loans (personal_loan) $38.4k / $24.9k, Civic loan $13.1k | Saving for a first home in two years; hurt by high card utilization. Carries the **account takeover** and the **card-testing burst**. Scores 671 / 648. |
| `hh_nguyen` | Tom 72 (pension + SS), Linh 70 (SS), Garland | checking, savings $28k, **three CDs** ($25k matures **2026-12-05**, $50k 2027-02-14, $75k 2027-08-30), Tom's IRA $356k, Linh's Roth $119k, one card paid in full. No mortgage. | Elder-scam target; scores 812 / 806. |
| `hh_patel` | Priya 34 (part-time dental payroll + DoorDash / Uber / Instacart), Aarav 8 | checking $165 at a small bank (messy import), savings $212, secured card 75% utilization, Sentra loan $8.4k at 12.9%, QuickRise installment loan $1,060 at 34.9% | Overdraft risk: **12 overdraft fees ($420)** since May, two late-rent fees ($75, Aug 8 and Oct 8), family help via Zelle from her sister Neha (see `Zelle - Neha Shah` rows). Next paycheck Fri 2026-11-13; QuickRise payment Tue Nov 10; insurance Fri Nov 13. Score 571, 3 late payments. Carries the data-quality problems. |
| `hh_brooks` | Terrence 46 ($96k), Danielle 44 ($71.5k), Jordan 16 (part-time), Walter 74 (Terrence's father, Social Security, home aide $640/mo) | checking, emergency fund $11,800, **Jordan's 529 plan** $27,400 (a `savings` account, $450/mo), Danielle's IRA, mortgage $198,400 (3.375%), SUV loan $22,900, one card | Multigenerational. Clean apart from one benign roof-repair **outlier** and one double-posted Walgreens charge. |

Demo hooks that hold in the data:
* Rivera naive 30-day forecast (checking $4,409, obligations plus recurring income only) bottoms out around **2026-12-01**
  (about 24 days out, about $2.4k): payroll on Nov 27, then mortgage, volleyball, academy and college transfer on Dec 1.
* Nguyen: the four scam purchases land 13:04 to 15:02 on 2026-10-21, after the noon call recounted in `conv_nguyen_01`.
  They are the only gift-card rows in six months.
* Okafor's conversation mentions "that weird transfer in September" (the $4,650 takeover) and the House Fund math ($22.3k, $27k without it).
* Patel's conversation uses the real balance, overdraft count and total from the generated ledger.

## Family voting (docs/contracts.md section 6)

`proposals.py` (called by `generate.py`) writes one **open** proposal per household and a few seeded votes; deterministic, standard library only
(the seeded RNG only varies posting times). Created 2026-11-06, open 7 to 14 days. Loaded by `seed_proposals` / `seed_votes`; each new
proposal queues an affordability check (`what_if` job), and the worker's verdicts for the seed data (local provider, `npm run seed` then
the worker) are the last column.

| Proposal id | Household | Title | Amount | `details` the check reads | Votes (member: choice) | Worker verdict |
|---|---|---|---:|---|---|---|
| `prop_rivera_second_location` | rivera | Take the SBA loan for the second bakery location | $250,000 | `kind: loan`, `rate_pct 10.75`, `term_months 120`, `proceeds_to_cash false` | Marisol yes, Daniel abstain, Elena yes | risky: the ~$3.4k payment is above today's monthly cash flow |
| `prop_okafor_starter_home` | okafor | Down payment on a starter home | $38,000 | `kind: down_payment`, `home_price 190000`, `down_pct 20` | Amara yes, Chidi no | risky: more than the $25.2k in checking and savings |
| `prop_nguyen_cd_for_kevin` | nguyen | Move $25k from the CD to help our grandson | $25,000 | `kind: transfer`, `note`: Kevin "needs bail money today and asked us not to tell his parents" | Tom yes, Linh abstain | risky: **scam guard** (grandchild in trouble + bail + secrecy, linked to the four $500 gift-card purchases of Oct 21); the money alone would be fine |
| `prop_patel_used_car` | patel | Buy a reliable used car | $14,000 | `kind: purchase`, `down_pct 10`, `term_months 60`, `rate_pct 18.5` | Priya yes, Aarav yes | risky: $377 in the bank, a negative monthly cash flow |
| `prop_brooks_hawaii_trip` | brooks | Family trip to Hawaii | $6,000 | `kind: purchase` (cash), `dates`, `travelers`, `note` | Terrence yes, Danielle yes, Jordan yes | fine |

Row shapes (the reducers also accept `details_json` as a string): `Proposal { id, household_id, title, amount, details: {...}, created_by_name,
created_at, closes_at (ISO), status: "open" }`, `Vote { id: "<proposal_id>:<voter_key>", proposal_id, household_id, voter_key (member id),
voter_name, choice: "yes"|"no"|"abstain", updated_at }`. `details` keys the worker understands: `kind` (`loan`, `down_payment`, `transfer`,
`purchase`), `down_pct`, `term_months`, `rate_pct`, `proceeds_to_cash`; any string value is also read by the scam detector for proposals that move
money to family.

## Planted anomalies (ids for seed 2026; `generate.py --report` prints them for any seed)

2,918 transactions, 41 labelled (1.4%; 37 excluding the 4 benign outliers, under the 3% cap; asserted).

| Label | Household | Transaction ids | What it is |
|---|---|---|---|
| `account_takeover` | okafor, `acct_okafor_sav` | `txn_001106`, `txn_001107` | 2026-09-17: new Zelle payee added 02:51 CT, $1.00 test at 02:58, **$4,650.00 sent at 03:07** from the House Fund, new device (times are in `description`). |
| `card_testing` | okafor, `acct_okafor_card_a` | `txn_001018` .. `txn_001024` | 2026-08-26: seven charges of $0.99 to $1.50 at "TMRW PAY 7731" between 14:02 and 14:08. |
| `scam_payment` | nguyen, `acct_nguyen_chk` | `txn_001635` .. `txn_001638` | 2026-10-21: four $500 gift-card purchases (CVS 13:04, Walgreens 13:41, Target 14:25, Kroger 15:02) = **$2,000**, category `gift_cards`. |
| `duplicate` | okafor | `txn_000786` (Chipotle, card), `txn_001044` (QuikTrip) | Exact copy of an earlier row, same day or next day, new id. |
| `duplicate` | patel | `txn_001745`, `txn_001869`, `txn_001900`, `txn_001914` (card), `txn_002016`, `txn_002066`, `txn_002100`, `txn_002155` | Same. |
| `duplicate` | brooks | `txn_002415` | Walgreens charge posted twice. |
| `garbled` | okafor | `txn_000919` | Mojibake merchant ("AmÃ¡zon") and description. |
| `garbled` | patel | `txn_001673`, `txn_001749`, `txn_001754`, `txn_001756`, `txn_001764`, `txn_001902`, `txn_001956`, `txn_002047`, `txn_002070` | Mix of mojibake ("DÃ³llÃ¡r TrÃ©e", "SavÃ© A Lot") and random-symbol corruption ("Mc*onald'*", "R‡ceTr@c", "$ld*"); the real merchant is still recoverable from the description or amount history. |
| `impossible_value` | patel | `txn_002007` | **$9,999,999.99 Starbucks** on 2026-08-22. |
| `impossible_value` | patel | `txn_002232` | Rent $1,285.00 **dated 2026-12-05** (future posting). |
| `impossible_value` | patel | `txn_002233` | DoorDash deposit $284.50 **dated 2027-01-03** (future posting). |
| `outlier` (benign) | rivera / nguyen / patel / brooks | `txn_000505` ($3,412.18 hospital), `txn_001468` ($1,240 dental crown), `txn_002039` ($1,146.37 car repair), `txn_002711` ($2,860 roof leak) | Large but legitimate one-offs: a good data-quality agent should flag them as unusual, not as fraud. |

Not labelled but worth knowing: Patel's 12 overdraft fee rows (`description = "OVERDRAFT FEE - ITEM PAID"`) and 2 late
fees; Nguyen's single RMD (Sep 30) and Okafor's $486.20 Southwest charge are normal.

## Conversations (6 sample Huddles) and expected goals

Goal ids are `goal_*`; each `evidence_quote` is a verbatim substring of a turn (asserted).

| Id | Household | Turns | Expected goals |
|---|---|---:|---|
| `conv_rivera_01` "A second bakery on Gaston Avenue (and the SBA idea)" | rivera | 24 | `goal_rivera_second_location` ($250k, 2027-09-30, stretch), `goal_rivera_sba_prequal` ($250k, 2026-12-01), `goal_rivera_bakery_reserve` |
| `conv_rivera_02` "Abuela's care and Sofia's college fund" | rivera | 22 | `goal_rivera_elena_care` ($9,000), `goal_rivera_medicare_enrollment` (2026-12-07), `goal_rivera_college_fund` ($60k, 2029-08-15, stretch) |
| `conv_okafor_01` "Buying our first home in two years" | okafor | 22 | `goal_okafor_first_home` ($30k, 2028-10-31), `goal_okafor_card_paydown` ($6.8k), `goal_okafor_emergency_fund` ($15k, off_track) |
| `conv_nguyen_01` "The phone call about Kevin" | nguyen | 22 | `goal_nguyen_scam_report` ($2,000), `goal_nguyen_scam_shield`, `goal_nguyen_cd_decision` ($25k CD, 2026-12-05). Has 8 `scam_signals`. |
| `conv_patel_01` "Making it to Friday" | patel | 16 | `goal_patel_next_paycheck` (2026-11-13), `goal_patel_starter_cushion` ($500, 2027-01-31), `goal_patel_gig_savings_rule` (15% of payouts) |
| `conv_brooks_01` "The roof, Pop's care, and Jordan's college money" | brooks | 26 | `goal_brooks_roof` ($14.5k, 2027-04-15), `goal_brooks_529` ($60k, 2028-08-15), `goal_brooks_jordan_car` ($8.5k, 2027-06-30) |

Speakers use natural speech (ums, interruptions, kids chiming in, some Spanish). Numbers spoken in the transcripts
match the ledger: Rivera emergency fund $14k and college fund $21.5k / $500 a month, Okafor House Fund $22.3k and
$600 a month, utilization 86% / 61%, Brooks 529 $27.4k / $450 a month and emergency fund $11.8k.
`feasibility` on the expected goals is the intended reading, not a computed value.

## Invariants asserted by `generate.py`

All 8 account types present; ids prefixed (`hh_ mem_ acct_ txn_ obl_ conv_ goal_`); every account owner is a member of the
same household; no negative deposit balances; (non-fatal checks that print a warning on stderr: no negative running balance on any non-Patel
checking account, card balances within limit); at least one row of each of the 7 anomaly labels; non-outlier anomalies under 3%; no
transaction dated after 2026-11-06 unless `impossible_value`; 12 to 30 turns per conversation; 2 conversations for
Rivera and 1 for each other household; evidence quotes verbatim; `scam_signals` on the Nguyen conversation; exactly one proposal per household
(`prop_` ids, the five titles and amounts above, `closes_at` after `created_at`, status open); every vote references a proposal of the same
household, comes from a member of that household, uses a valid choice and appears once; the Nguyen proposal is scam-adjacent (grandson,
"not to tell").
