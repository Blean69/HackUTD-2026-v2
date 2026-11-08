# PNC HackUTD 2026 dataset (vendored) and the Plaid Sandbox bank profiles built from it

## Source, license, attribution

* Source: <https://github.com/devfulcrum/pnc-utd-hackathon-2026> (commit `55999aba3561270778f7830026bae666c5428740`, 2026-11-07,
  author Muthu Venkataraman), the "PNC x UT Dallas AI Financial Wellness" workshop package published for the PNC challenge at HackUTD 2026.
* License: **Apache License 2.0** (the repository's `LICENSE`, copied unchanged to `data/pnc/LICENSE`). The repository has no `NOTICE` file and
  its copyright line is the unfilled template (`Copyright [yyyy] [name of copyright owner]`), so there is no further notice to carry.
* Redistribution is allowed (Apache-2.0 section 4: give recipients the license, keep notices, state changes), so the raw files **are vendored**
  unchanged in `data/pnc/raw/`:
  `profiles.csv`, `accounts.csv`, `transactions.csv` (2.9 MB), `monthly_statements.csv`, `history_manifest.json`,
  `DATASET_README.md` (the dataset's own `Lab_Package/data/README.md`), plus `FINANCIAL-INDICATORS-100.md` and `financial_tools.py` from `Lab_Package/`
  (used for `docs/pnc-indicators.md`). SHA-256 of each file:

  ```
  871edce7db69a5391d667500c22c44cadb71b4abff8d735e296e90e679258417  raw/accounts.csv
  f1d2834966d7bd78555414d35e5e9c55c1de1e2d5cf062e99e3b7d4d7a4153e7  raw/DATASET_README.md
  50f2efefa36c36d309e84fcb073447eaa536d41111e8a6bd6d1f314d2f384ee7  raw/FINANCIAL-INDICATORS-100.md
  92b99e154c7691d37198fc5b7aad182de9866ecc5485af2bc43ba97a595e96d7  raw/financial_tools.py
  8647dca7af21868d0d331ed78c420c28789efd4b351e0a447abc43d79edfd5b5  raw/history_manifest.json
  080ea9c1b496ce03b971581840f4725e176bfef878c7ea2492c1c1798176f1bd  raw/monthly_statements.csv
  ef153df8ed4c56934df6563153c0b301b35012fc2881184c184d6a77f69c2a92  raw/profiles.csv
  638643933cbbbdb6bb5714a83577c957f2abf04fec4bfcf7d0437510a31775f2  raw/transactions.csv
  ```
* Attribution to show wherever the data is surfaced: "Sample customers derived from PNC's synthetic HackUTD 2026 financial-wellness dataset
  (Apache-2.0, github.com/devfulcrum/pnc-utd-hackathon-2026)".
* **Changes made (Apache-2.0 section 4b):** the raw files are untouched. `data/pnc_profiles.py` derives new files from them (below): dates shifted
  by a constant, merchant-style descriptions added, amounts re-signed to Plaid's convention, last six months kept, invented first names/occupations/goals
  added as persona text. Those derived files are our work, built on PNC's data; they are not PNC products.
* The data is synthetic ("No real account data"); the dataset README says it must not be used for underwriting, trading, investment advice or production decisions.
  It only has `monthly_income`, `monthly_non_debt_expenses` and `credit_limit` per customer (no names, ages or jobs).

## What the dataset is

30 customers (`C001`-`C030`), 196 accounts (checking, savings, IRA, credit card for everybody; CD 19, auto loan 15, personal loan 21, mortgage 21),
24 months of ledger (2024-11-01 .. 2026-10-31, 21,225 rows) with running balances that reconcile to `accounts.csv`, and 4,704 monthly statements.
Paychecks come twice a month, the fixed-share spending categories (housing, utilities, groceries, other) once a month, and card purchases four times a month, so every
customer has about 25 cash/card rows per month. Loan and card interest, fees and payments are explicit rows; internal transfers appear as two matching legs.
`net_worth_partial` in PNC's tools is deliberately incomplete: mortgages are listed but the homes are not, which is why most homeowners look "underwater" before the
onboarding questions add `home_value`.

## Plaid Sandbox profiles (`python3 data/pnc_profiles.py`, also run by `python3 data/generate.py`)

Writes `data/plaid/profiles/pnc_c001.json` ... `pnc_c030.json` (each a Plaid custom-user config, 24-30 kB) and `data/plaid/profiles/index.json`
(31 entries: `family_demo` from `data/plaid/sandbox_user.json` first, then the 30 customers), the shape served by `GET /plaid/sandbox_profiles`
(`docs/contracts.md` section 7b). Deterministic: re-running gives byte-identical files.

| Choice | Detail |
|---|---|
| Account mapping | checking, savings, cd -> `depository/checking|savings|cd`; credit_card -> `credit/credit card` (+ `liability`: APR, minimum payment = PNC's scheduled payment, last statement balance from `monthly_statements.csv`, limit from `profiles.csv`); auto_loan -> `loan/auto`; personal_loan -> `loan/consumer`; mortgage -> `loan/mortgage`; ira -> `investment/ira` with ETF `holdings` summing to the balance. All eight land in Keystone's types without asking a model (`mapAccountType`). |
| Balances | `starting_balance` = PNC closing balance as of 2026-10-31 (verified live: Plaid returns it verbatim as the current balance). Debts are positive amounts owed. |
| Signs | Plaid's: positive = money out of a deposit account or a charge on a card; paychecks, transfers in, interest earned and card payments are negative. PNC's `balance_change` is converted per account kind; both legs of every transfer/payment keep PNC's amount and date. |
| Window | The most recent 6 whole calendar months per customer (2026-05 .. 2026-10), lowered to 5/4/3 only if a customer would exceed Plaid's caps. **All 30 fit 6 months**: 136-191 transactions each (cap: Plaid says ~250, we stop at 240), 24-30 kB (cap ~55 kB, we stop at 50 kB), 5-8 accounts (cap 10). |
| Dates | One constant shift of +6 days: PNC's 2026-10-31 becomes 2026-11-06; every interval is kept. `roll_dates_forward: true` makes Plaid re-anchor the newest day to the day the Item is created. |
| Loans | Their ledger is kept (`PAYMENT RECEIVED MORTGAGE XXXX4155`, interest charge, servicing fee), because the loan-side leg is what lets the net-worth math cancel a checking-to-loan payment, as in `data/seed`. No `liability` block: any `loan` liability block makes Plaid answer INTERNAL_SERVER_ERROR (tested for auto, consumer and loan subtypes), `student` blocks are replaced by random data, mortgages are unsupported. APR and scheduled payment are therefore in the index preview (`rate_pct`, `monthly_payment`), not in Plaid. |
| IRA | Holdings only (VTI/VXUS/BND, mix by life stage), no investment transactions: the worker does not read them and they would eat the 250 cap. |
| Descriptions | PNC says only "Payment", "Withdrawal", "Purchase" plus a category. Each row gets a realistic statement descriptor (e.g. `HEB #433 PLANO TX`, `DIRECT DEP TRINITY RIVER SCHOOLS PAYROLL`, `ONLINE TRANSFER TO SAVINGS 1479`, `MORTGAGE PAYMENT XXXX4155`) chosen by a sha256 of stable keys; employers and landlords are fictional, store brands are real national/Texas chains. Plaid's own enrichment (merchant, category) then works. |
| Personas | `display_name` = `<first name>, <life stage> <job>, <story>`, e.g. "Marcus, mid-career teacher, balancing the mortgage with retirement saving". Life stage = IRA balance vs a year of income, job = income band, story = first rule that matches income, expenses, scheduled debt payments, cash runway and card utilization. Names, jobs and stages are fictional storytelling, not PNC fields. |

### Not carried over
PNC's `external_cash_management` rows (artificial calibration flows to an "unlisted external account") are kept as `ACH TRANSFER TO/FROM EXTERNAL BROKERAGE XXXX....`
transfers so the balances reconcile; they are categorised as transfers and are not spending or income.

## Verified live (Plaid Sandbox, 2026-11-07)

* All 30 profiles are accepted by `/sandbox/public_token/create` (custom user, `days_requested: 365`): accounts, types, subtypes and balances come back exactly as written, and the
  per-account transaction counts match the files (e.g. `pnc_c002`: 8 accounts, 190 transactions). Plaid delivers a 130-190 row history in several batches over ~10-20 s, so the worker waits
  for three quiet polls (`PLAID_QUIET_POLLS`, default 3) before it calls a fresh item loaded.
* End to end through the worker (`start_onboarding` -> `sandbox_connect {profile_id, select: true}` -> account options -> select all -> `plaid_sync`) with `LLM_PROVIDER_ORDER=local`:
  `pnc_c001`, `c002`, `c003`, `c009`, `c013`, `c024`, `c030` and `family_demo` all sync with every account and every transaction.
* Known gaps: IRA contributions show only as an outflow on the checking side (investment accounts have no cash ledger in `/transactions/sync`), and PNC's artificial
  external-transfer flows leave the checking account without a counterpart leg, so the 90-day `net_worth_trend` indicator reads lower than the savings rate suggests.
