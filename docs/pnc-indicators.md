# PNC's 100 indicators vs our 8 health indicators (pitch notes)

Source: `data/pnc/raw/FINANCIAL-INDICATORS-100.md` and `financial_tools.py` (PNC's HackUTD 2026 package, Apache-2.0; see `data/pnc/README.md`).
Ours: the eight indicators computed inside SpacetimeDB (`spacetime/src/finance.ts`): `liquidity_runway`, `debt_to_income`, `credit_utilization`,
`savings_rate`, `net_worth_trend`, `emergency_fund`, `forecast_low_point`, `credit_score`.

**What PNC's 100 are.** They are not 100 health checks for one family. They are *cross-customer aggregates* of the same data: 10 per-customer base metrics x 8 distribution
statistics (mean, median, min, max, p10, p25, p75, p90) = 80, plus 20 portfolio shares and ratios. So the honest comparison is: PNC's **10 base metrics** are the
per-family indicators; the other 90 are what a bank sees when it looks at a book of customers (our Advisor Console is exactly that surface).

## 1. The 10 base metrics against our 8

| PNC base metric | Do we compute it? | Where / how it differs |
|---|---|---|
| `debt_payment_to_income_pct` | **Yes** | `debt_to_income`. Same ratio, same idea (scheduled debt payments / monthly income); status bands 36/43 %. For Plaid banks the loan payments are now read from payment history when Plaid has no loan terms (`inferMonthlyPayment`). |
| `credit_card_utilization_pct` | **Yes** | `credit_utilization` (card balance / limit). |
| `savings_rate_pct` | **Yes** | `savings_rate` (3 months, observed deposits vs outflows; PNC uses stated income minus stated expenses and scheduled payments). |
| `emergency_fund_months` | **Yes, twice** | `liquidity_runway` (checking + savings in months of spending) and `emergency_fund` (savings vs a 3-month cushion). PNC divides liquid assets by expenses *plus* debt payments; we use observed spending. |
| `liquid_assets` | Partly | Shown inside the `liquidity_runway` explanation; not a card of its own. |
| `monthly_income` | Input only | Stated (onboarding members) or observed deposits; feeds DTI and savings rate. |
| `monthly_non_debt_expenses` | Input only | `observedExpenseMonthly` in `finance.ts`; feeds savings rate and runway. |
| `monthly_debt_payments` | Input only | Numerator of `debt_to_income`. |
| `monthly_cash_surplus` | Implicit | It is `saved` inside `savings_rate` (income - expenses), never shown in dollars on its own. |
| `liquid_assets_to_debt_pct` | **No** | Not computed. |

What PNC does **not** have and we do: `net_worth_trend` (90-day change, reconstructed from transactions), `forecast_low_point` (90-day balance forecast with recurring
obligations and a projected-overdraft alert) and `credit_score`. PNC's `net_worth_partial` is deliberately incomplete (mortgages without homes); ours adds `home_value` and
`vehicle_value` from the onboarding answers.

## 2. The 20 portfolio indicators

| PNC indicator | Status for us |
|---|---|
| `pct_negative_monthly_surplus`, `pct_positive_monthly_surplus` | Cheap: one line over `household` rows in the Advisor Console. |
| `pct_emergency_fund_lt1_month`, `pct_emergency_fund_lt3_months` | Cheap: from `liquidity_runway` per household. |
| `pct_high_dti_gt40` | Cheap: from `debt_to_income` (our "risk" band starts at 43 %, so use PNC's 40 for the pitch number). |
| `pct_high_card_util_gt70` | Cheap: from `credit_utilization`. |
| `pct_negative_savings_rate` | Cheap: from `savings_rate`. |
| `pct_positive_net_worth_partial` | We can do better (full net worth); not needed. |
| `avg/median_transaction_count_per_customer` | Trivial count of `txn` rows; of no pitch value. |
| `avg/median_spending_to_income_history_ratio` | Cheap: spending / income over the Plaid window. |
| `avg/median_debt_interest_share_of_spending` | Cheap and meaningful: sum of `interest` category over spending; Plaid tags card and loan interest as `BANK_FEES_INTEREST_CHARGE` (`mapCategory` -> `interest`), and the PNC profiles carry them. |
| `avg/median_fees_to_income_ratio` | Cheap: the `fees` category over income. |
| `pct_customers_with_external_transfers`, `avg/median_external_transfer_dependency_ratio` | Skip: they measure PNC's artificial calibration flows, not behaviour (the dataset README says so). |
| `customer_count_reviewed` | Trivial. |

## 3. Pitch numbers from PNC's 30 sample customers (snapshot definitions, computed with `data/pnc_profiles.py` helpers)

Using PNC's own definitions (scheduled debt payments, liquid = checking + savings):

* 30 % (9 of 30) have a negative monthly cash surplus (income - non-debt expenses - scheduled debt payments), so "70 % positive".
* 0 % have under 1 month of liquid cushion, but 57 % (17 of 30) are under 3 months.
* 17 % (5 of 30) have debt payments above 40 % of income; 13 % (4 of 30) run their card above 70 % utilization.
* Medians: DTI 14.2 %, card utilization 30.7 %, savings rate 19.2 %, 2.8 months of liquid cushion.

The same shapes show up when the profiles are connected through Plaid, e.g. `pnc_c024` (over-limit card, 187 % utilization, DTI 40 % once the mortgage payment is read from history).

## 4. What is worth adding (smallest first)

1. **Portfolio strip in the Advisor Console** using the six "pct_*" counts above (one query over `health_indicator`), 30 sample families make a believable "book of business".
2. **`liquid_assets_to_debt_pct`** as a ninth card (liquid / total debt balances): one line in `finance.ts`, explains "could you clear your debts from cash".
3. **Monthly cash surplus in dollars** next to `savings_rate` (already computed as `saved`).
4. **Debt-interest share of spending** (what interest costs you each month); the data is already in the `interest` category.
5. Not worth it: PNC's distribution statistics (mean, p10 ... p90) per family; they only mean something across customers.
