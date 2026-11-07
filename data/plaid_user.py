#!/usr/bin/env python3
"""Plaid Sandbox *custom user* for a synthetic American family, the Whitfields (fictional, no real PII).

    python data/plaid_user.py        # writes data/plaid/sandbox_user.json and prints a summary

The JSON is the "custom user configuration object" from
https://plaid.com/docs/sandbox/user-custom/ . Use it one of two ways:

  * Sandbox Studio / Dashboard: paste it as a named custom user (Build -> Sandbox -> Users), then Link with that
    username and any non-empty password.
  * API: POST /sandbox/public_token/create with
        options.override_username = "user_custom"
        options.override_password = to_override_password(cfg)      # the JSON *as a string*, see below
        options.transactions.days_requested = 180                  # default is 90 -> only ~half the history shows!
    and institution_id "ins_109508" (First Platypus Bank, non-OAuth) with initial_products covering what you need
    (transactions, auth, identity, liabilities, investments).

Plaid doc facts that shaped this file (checked against the live docs, Nov 2026)
------------------------------------------------------------------------------
* Top-level keys (all optional): version, seed (string), roll_dates_forward, has_perpetual_otp, override_accounts,
  mfa, recaptcha, force_error. We emit only seed, roll_dates_forward and override_accounts.
* Account keys used: type, subtype, starting_balance, force_available_balance, meta {name, official_name, mask,
  limit, apy}, numbers {account, ach_routing}, identity, transactions, liability, holdings, investment_transactions.
  (The `numbers` keys are `account`/`ach_routing`/`ach_wire_routing`, NOT `routing_number`.)
* Transaction objects take ONLY date_transacted, date_posted, amount, description, currency. There is no `status`
  field: a transaction is pending iff date_posted is in the future. Everything here is posted.
* Sign convention: Plaid's normal one. The custom-user docs only say the amount "can be negative"; Plaid's own sample
  users (github.com/plaid/sandbox-custom-users: card purchases positive, "Transfer into ..." on checking negative)
  follow the standard API convention: POSITIVE = money leaving a depository account / a charge that increases a credit
  balance, NEGATIVE = money coming in / a credit-card payment or refund. So paychecks and transfers-in are negative,
  purchases and loan payments are positive.
* starting_balance: "the account will start with this amount as the current balance". Credit and loan balances are the
  amount owed (positive). The docs do not say whether Plaid back-solves balances from transactions, so the data is built
  to be believable under BOTH readings (starting_balance = balance today, or = balance before the first transaction):
  net cash flow on checking is ~0 and the validator checks the running balance under both readings.
* Dates are fixed ISO (YYYY-MM-DD, UTC). There is NO relative-date syntax ("today"/"N days ago" is not supported).
  The supported way to keep history recent is `roll_dates_forward: true`: at Item creation Plaid shifts EVERY date in
  the config forward so the most recent activity date lands on the creation date (spacing preserved; liability dates
  such as next_payment_due_date shift too). We anchor on the repo's fixed "today" (2026-11-07, last activity 2026-11-06),
  so an Item created on 2026-11-07 is shifted by +1 day, and one created a week later by +8 days. Set
  ROLL_DATES_FORWARD = False to pin the exact dates instead. Every date_posted here is <= the latest activity date, so
  nothing becomes pending after a roll.
* Limits: "larger than approximately 55kb, or approximately 250 transactions" is unsupported and may make Link fail;
  more than ten accounts fails. We stay far below (<= MAX_TX transactions in total across all accounts, including
  investment transactions, and a compact JSON under MAX_COMPACT_BYTES). Plaid documents no limit on the length of
  override_password itself; treat the 55 KB figure as the budget.
* Liability blocks (account.liability, `type` is required inside it) support exactly: credit (credit card), student,
  loan (closed-end loan) and line_of_credit.  **Mortgages are not supported by the custom sandbox** ("Mortgages are
  not currently supported in the custom Sandbox"), so the mortgage account here is a plain loan/mortgage account with a
  balance and meta but NO liability block; its rate/payment live in MORTGAGE_TERMS for the app to use.
  The docs suggest an auto loan may carry a `loan` block, but tested live (Nov 2026) Plaid answers INTERNAL_SERVER_ERROR
  to /sandbox/public_token/create whenever such a block is present and `liabilities` is among the initial_products,
  so AUTO_LOAN_LIABILITY is False: the auto loan, like the mortgage, is a plain account with a balance. Only the credit
  card carries a liability block. Every initial_products combination of transactions/liabilities/investments was
  accepted with this configuration.
* "If no override is specified, transactions and account data will be randomly generated", so the two loans carry an
  explicit `"transactions": []` (assumption: an explicit empty list suppresses the random data; the docs do not say.
  If random transactions show up on the loans, that is why). Student-loan accounts do not accept
  /sandbox/transactions/create.
* Inflow/payment simulation (`inflow_model`) is deliberately not used: it injects extra generated transactions relative
  to the Item creation date and would double-count the payroll and card payments written out below.

Determinism: all randomness comes from random.Random(f"keystone:{seed}:plaid_user"); output is byte-identical per seed.
Standard library only.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import random
import sys

# ---------------------------------------------------------------------------------------------------------- constants
TODAY = dt.date(2026, 11, 7)            # fixed repo "today" (see data/ledger.py)
HIST_START = dt.date(2026, 5, 8)
HIST_END = dt.date(2026, 11, 6)         # "yesterday"
ONE = dt.timedelta(days=1)

ROLL_DATES_FORWARD = True               # Plaid shifts all dates so the newest activity lands on the Item-creation day
AUTO_LOAN_LIABILITY = False             # True makes Plaid answer INTERNAL_SERVER_ERROR whenever `liabilities` is in initial_products (tested live Nov 2026)

MAX_TX = 240                            # docs: ~250 transactions total is the practical ceiling
MAX_COMPACT_BYTES = 50_000              # docs: ~55 kb; the compact string is what goes in override_password
MAX_FILE_BYTES = 55_000

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plaid", "sandbox_user.json")

# Account family targets (dollars)
CHECKING_BALANCE = 6200
SAVINGS_BALANCE = 18500
CD_BALANCE = 30000
IRA_BALANCE = 88000
CARD_OWED = 1850
CARD_LIMIT = 9000
CARD_PURCHASE_APR = 21.9
MORTGAGE_BALANCE = 212000
AUTO_BALANCE = 14300

NET_PAY_A = 231000                      # cents: earner A, semi-monthly (1st & 15th)   -> 4,620 / month
NET_PAY_B = 152500                      # cents: earner B, biweekly Fridays            -> ~3,304 / month
MORTGAGE_PAYMENT = 187000               # cents, principal + interest + escrow
AUTO_PAYMENT = 45500
SAVINGS_TRANSFER = 125000               # cents, monthly auto-transfer checking -> savings
IRA_CONTRIBUTION = 50000                # cents, monthly checking -> IRA
CHECKING_NET_TARGET = 25000             # cents: net checking cash flow over the window (checking ends ~$250 above where it began)

# Not in the JSON (Plaid cannot take a mortgage liability block); exposed for the app / generate.py.
MORTGAGE_TERMS = {
    "account_mask": "0004",
    "remaining_balance": MORTGAGE_BALANCE,
    "interest_rate_pct": 3.75,
    "rate_type": "fixed",
    "monthly_payment_incl_escrow": MORTGAGE_PAYMENT / 100,
    "est_monthly_escrow": 560.00,
    "est_monthly_principal_interest": 1310.00,
    "payment_day_of_month": 1,
    "original_principal": 283000,
    "original_term_months": 360,
    "origination_date": "2015-09-01",
}

FED_HOLIDAYS = {dt.date(2026, 5, 25), dt.date(2026, 6, 19), dt.date(2026, 9, 7), dt.date(2026, 10, 12), dt.date(2026, 11, 11)}

# type -> subtypes (subset of Plaid's account-type schema, covering every pair this file can emit)
VALID_PAIRS = {
    "depository": {"checking", "savings", "cd", "money market", "cash management", "hsa", "prepaid"},
    "credit": {"credit card", "paypal"},
    "loan": {"auto", "mortgage", "student", "consumer", "home equity", "line of credit", "loan", "commercial"},
    "investment": {"ira", "401k", "brokerage", "roth", "roth 401k", "529", "hsa"},
}
LIABILITY_KEYS = {
    "credit": {"type", "purchase_apr", "cash_apr", "balance_transfer_apr", "special_apr", "last_payment_amount",
               "last_statement_balance", "minimum_payment_amount", "is_overdue"},
    "loan": {"type", "account_number", "interest_rate", "principal_balance", "origination_principal_amount",
             "origination_date", "loan_term_months", "maturity_date", "payment_count", "payment_frequency",
             "next_payment_amount", "next_payment_due_date", "last_payment_amount", "last_payment_date",
             "payoff_amount", "ytd_interest_paid", "compounding_period"},
}
TX_KEYS = ["date_transacted", "date_posted", "currency", "amount", "description"]

# ---------------------------------------------------------------------------------------------------------- helpers


def is_bizday(d: dt.date) -> bool:
    return d.weekday() < 5 and d not in FED_HOLIDAYS


def next_biz(d: dt.date) -> dt.date:
    while not is_bizday(d):
        d += ONE
    return d


def prev_biz(d: dt.date) -> dt.date:
    while not is_bizday(d):
        d -= ONE
    return d


def money(c: int) -> int | float:
    """Cents -> JSON number (int when whole, else 2-decimal float)."""
    return c // 100 if c % 100 == 0 else round(c / 100, 2)


def months():
    for m in range(5, 12):
        yield 2026, m


def month_end(y: int, m: int) -> dt.date:
    return (dt.date(y + (m == 12), m % 12 + 1, 1)) - ONE


class Acct:
    """Collects internal events: t=date_transacted, p=date_posted, c=cents (Plaid sign), d=description."""

    def __init__(self) -> None:
        self.ev: list[dict] = []

    def add(self, t: dt.date, desc: str, c: int, *, lag: int = 0, p: dt.date | None = None,
            biz: bool = True, flex: bool = False) -> dict | None:
        if not (HIST_START <= t <= HIST_END):
            return None
        if p is None:
            p = t + dt.timedelta(days=lag)
            if biz:
                p = next_biz(p)
        p = min(p, HIST_END)                      # never newer than the anchor -> nothing turns pending after a roll
        assert p >= t
        e = {"t": t, "p": p, "c": c, "d": desc, "flex": flex}
        self.ev.append(e)
        return e

    def rows(self) -> list[dict]:
        self.ev.sort(key=lambda e: (e["t"], e["p"], e["d"], e["c"]))
        return [{"date_transacted": e["t"].isoformat(), "date_posted": e["p"].isoformat(), "currency": "USD",
                 "amount": money(e["c"]), "description": e["d"]} for e in self.ev]


def _rescale(events: list[dict], target_sum: int, lo: float, hi: float, what: str) -> float:
    """Scale the flexible events so their signed sum is target_sum (cents); residual lands on the largest one."""
    cur = sum(e["c"] for e in events)
    f = target_sum / cur
    assert lo <= f <= hi, f"{what}: scale factor {f:.3f} outside [{lo}, {hi}] - retune constants"
    for e in events:
        e["c"] = max(100, int(round(e["c"] * f)))
    resid = target_sum - sum(e["c"] for e in events)
    max(events, key=lambda e: e["c"])["c"] += resid
    return f


def _wpick(rng: random.Random, rows: list[tuple]) -> tuple:
    return rng.choices(rows, weights=[r[3] for r in rows], k=1)[0]


def _day_in_week(rng: random.Random, week_start: dt.date) -> dt.date:
    wd = {0: 1, 1: 1, 2: 1, 3: 1, 4: 2, 5: 4, 6: 3}       # errands skew to the weekend
    days = [week_start + dt.timedelta(days=i) for i in range(7)]
    return rng.choices(days, weights=[wd[d.weekday()] for d in days], k=1)[0]


def _amt(rng: random.Random, lo: float, hi: float) -> int:
    return int(round(rng.uniform(lo, hi) * 100))


# ---------------------------------------------------------------------------------------------- the family's money


def _build_events(rng: random.Random) -> dict[str, Acct]:
    chk, sav, cc, cd = Acct(), Acct(), Acct(), Acct()

    def put(use_card: bool, t: dt.date, desc: str, c: int) -> None:
        if use_card:
            cc.add(t, desc, c, lag=rng.choice([1, 1, 2]), flex=True)
        else:
            chk.add(t, desc, c, lag=rng.choice([0, 0, 1]), flex=True)

    # ---- payroll (negative = money in). Banks pay on the previous business day.
    for y, m in months():
        for day in (1, 15):
            d = prev_biz(dt.date(y, m, day))
            chk.add(d, "DIRECT DEP NORTHBRIDGE SOFTWARE PAYROLL", -NET_PAY_A, p=d)
    d = HIST_START                                           # a Friday; biweekly Fridays through 2026-11-06
    while d <= HIST_END:
        pay = prev_biz(d)
        chk.add(pay, "ACH CREDIT NORTH PLANO MEDICAL GROUP PAYROLL", -NET_PAY_B, p=pay)
        d += dt.timedelta(days=14)

    # ---- fixed monthly bills out of checking
    elec = {5: 141.20, 6: 168.95, 7: 242.38, 8: 269.11, 9: 231.74, 10: 152.60}
    water = {5: 58.20, 6: 69.40, 7: 88.15, 8: 96.30, 9: 82.40, 10: 61.20}
    for y, m in months():
        chk.add(dt.date(y, m, 1), "PRAIRIE STATE MORTGAGE HOME LOAN PMT", MORTGAGE_PAYMENT)
        chk.add(dt.date(y, m, 3), "YMCA OF METRO DALLAS MEMBERSHIP", 12800)
        chk.add(dt.date(y, m, 5), "LONESTAR AUTO LOAN PAYMENT", AUTO_PAYMENT)
        chk.add(dt.date(y, m, 9), "SPECTRUM INTERNET AUTOPAY", 8499)
        chk.add(dt.date(y, m, 10), "SUNRISE MUSIC AND ARTS ACADEMY PLANO", 39500)
        if m in elec:
            chk.add(dt.date(y, m, 12), "TXU ENERGY AUTOPAY", int(round(elec[m] * rng.uniform(0.97, 1.03) * 100)))
            chk.add(dt.date(y, m, 18), "CITY OF PLANO UTILITIES WATER", int(round(water[m] * rng.uniform(0.97, 1.03) * 100)))
        chk.add(dt.date(y, m, 21), "VERIZON WIRELESS AUTOPAY", 14218)
        # monthly auto-transfer to savings (pair) and IRA contribution (checking leg; IRA leg is an investment txn)
        td = next_biz(dt.date(y, m, 2))
        if chk.add(td, "ONLINE TRANSFER TO SAVINGS 0002", SAVINGS_TRANSFER, p=td):
            sav.add(td, "ONLINE TRANSFER FROM CHECKING 0001", -SAVINGS_TRANSFER, p=td)
        chk.add(dt.date(y, m, 5), "LONESTAR INVESTMENTS IRA CONTRIBUTION", IRA_CONTRIBUTION)

    # savings -> checking to fund the annual insurance premium (second transfer pair), then the premium itself
    td = dt.date(2026, 7, 8)
    chk.add(td, "ONLINE TRANSFER FROM SAVINGS 0002", -240000, p=td)
    sav.add(td, "ONLINE TRANSFER TO CHECKING 0001", 240000, p=td)
    chk.add(dt.date(2026, 7, 9), "STATE FARM INSURANCE ANNUAL PREMIUM", 240000)

    # ---- savings interest (month end, ~4.10% APY on a balance climbing from ~$14.5k to ~$18.5k)
    for i, (y, m) in enumerate([(2026, k) for k in range(5, 11)]):
        bal = 14600 + i * 740
        sav.add(month_end(y, m), "INTEREST PAYMENT", -int(round(bal * 0.041 / 12 * 100 * rng.uniform(0.96, 1.04))), p=month_end(y, m))
    # ---- 24-month CD pays interest quarterly: 30,000 * 4.60% / 4
    for d in (dt.date(2026, 6, 30), dt.date(2026, 9, 30)):
        cd.add(d, "INTEREST PAYMENT", -34500, p=d)

    # ---- subscriptions on the card
    for y, m in months():
        cc.add(dt.date(y, m, 3), "NETFLIX.COM", 1799, lag=1)
        cc.add(dt.date(y, m, 9), "SPOTIFY USA", 1999, lag=1)
        cc.add(dt.date(y, m, 14), "APPLE.COM/BILL", 999, lag=1)

    # ---- groceries: roughly weekly, Costco every ~4 weeks; HEB/Kroger/Aldi otherwise
    stores = [("HEB #433 PLANO TX", 150, 268, 5, 0.3), ("KROGER #523 PLANO TX", 122, 214, 2, 1.0),
              ("ALDI 73038 PLANO TX", 94, 158, 3, 0.0)]
    for i in range(27):
        ws = HIST_START + dt.timedelta(days=7 * i)
        if i % 4 == 2:
            t = _day_in_week(rng, ws)
            put(True, t, "COSTCO WHSE #1107 PLANO TX", _amt(rng, 268, 436))
        elif rng.random() > 0.03:
            t = _day_in_week(rng, ws)
            desc, lo, hi, _w, pc = _wpick(rng, stores)
            put(rng.random() < pc, t, desc, _amt(rng, lo, hi))

    # ---- gas, two cars, every 8-12 days
    gas = [("SHELL SERVICE STATION PLANO TX", 48, 78, 3, 0.45), ("QUIKTRIP #1128 PLANO TX", 44, 74, 3, 0.45),
           ("EXXONMOBIL FRISCO TX", 52, 82, 2, 0.45), ("COSTCO GAS #1107 PLANO TX", 42, 66, 2, 1.0)]
    d = HIST_START + dt.timedelta(days=rng.randint(1, 4))
    while d <= HIST_END:
        desc, lo, hi, _w, pc = _wpick(rng, gas)
        put(rng.random() < pc, d, desc, _amt(rng, lo, hi))
        d += dt.timedelta(days=rng.randint(8, 11))

    # ---- dining out
    dining = [("CHIPOTLE 2371 PLANO TX", 30, 58, 3, 0.5), ("WHATABURGER #614 FRISCO TX", 32, 64, 2, 0.4),
              ("CHICK-FIL-A #02201 PLANO TX", 28, 56, 3, 0.5), ("TORCHYS TACOS PLANO TX", 52, 94, 2, 0.7),
              ("STARBUCKS STORE 14477 PLANO TX", 9, 24, 2, 0.6), ("NICKS PIZZA AND PASTA PLANO TX", 44, 78, 2, 0.6),
              ("OLIVE GARDEN 1043 PLANO TX", 96, 156, 2, 0.9), ("BRAUMS ICE CREAM PLANO TX", 21, 40, 1, 0.3)]
    d = HIST_START + dt.timedelta(days=rng.randint(1, 3))
    while d <= HIST_END:
        desc, lo, hi, _w, pc = _wpick(rng, dining)
        put(rng.random() < pc, d, desc, _amt(rng, lo, hi))
        d += dt.timedelta(days=rng.randint(7, 11))

    # ---- household shopping
    d = HIST_START + dt.timedelta(days=rng.randint(3, 9))
    while d <= HIST_END:
        put(rng.random() < 0.6, d, "TARGET T-1184 PLANO TX", _amt(rng, 72, 232))
        d += dt.timedelta(days=rng.randint(22, 34))
    for d in (dt.date(2026, 10, 3),):
        put(False, d, "CVS/PHARMACY #4231 PLANO TX", _amt(rng, 18, 64))
    for d in (dt.date(2026, 5, 23), dt.date(2026, 10, 10)):
        put(True, d, "THE HOME DEPOT #6553 PLANO TX", _amt(rng, 54, 214))
    for d in (dt.date(2026, 10, 20),):
        sfx = "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
        put(True, d, f"AMAZON.COM*{sfx} AMZN.COM/BILL WA", _amt(rng, 38, 142))

    # ---- one-offs and kids' activities (fixed, not rescaled)
    cc.add(dt.date(2026, 6, 2), "SUNSHINE KIDS SUMMER CAMP", 42500, lag=1)
    cc.add(dt.date(2026, 7, 21), "BANFIELD PET HOSPITAL PLANO TX", 115000, lag=1)           # vet bill
    cc.add(dt.date(2026, 8, 17), "PLANO YOUTH SOCCER REGISTRATION", 19500, lag=1)
    cc.add(dt.date(2026, 10, 10), "CHUCK E CHEESE 0231 PLANO TX", 23840, lag=1)             # birthday party
    cc.add(dt.date(2026, 9, 12), "AMAZON.COM*3K9Q2X AMZN.COM/BILL WA", 18743, lag=1)       # bigger order
    cc.add(dt.date(2026, 9, 22), "AMAZON.COM*REFUND AMZN.COM/BILL WA", -4215, lag=1)        # refund on the card
    chk.add(dt.date(2026, 8, 19), "MIDAS AUTO SERVICE #2231 PLANO TX", 64000, lag=0)       # car repair
    cc.add(dt.date(2026, 5, 29), "DELTA AIR LINES 0062318845712", 168480, lag=1)             # summer trip: flights
    cc.add(dt.date(2026, 7, 1), "MARRIOTT ORLANDO FL", 124835, lag=1)                         # ... and hotel
    chk.add(dt.date(2026, 8, 6), "PLANO ISD STUDENT FEES", 28650, lag=0)
    cc.add(dt.date(2026, 8, 9), "OLD NAVY #6274 PLANO TX", 14872, lag=1)                      # back to school
    chk.add(dt.date(2026, 6, 17), "BRIGHT SMILES FAMILY DENTAL PLANO", 19500, lag=0)
    chk.add(dt.date(2026, 10, 21), "BRIGHT SMILES FAMILY DENTAL PLANO", 24500, lag=0)
    chk.add(dt.date(2026, 9, 19), "COSTCO TIRE CENTER PLANO TX", 81260, lag=0)               # new tires
    chk.add(dt.date(2026, 8, 12), "BEST BUY 00318 PLANO TX", 104999, lag=0)                  # school laptop
    chk.add(dt.date(2026, 7, 14), "TEXAS HEALTH URGENT CARE PLANO", 28500, lag=0)
    # (the $2,400 insurance premium is above, next to its savings transfer)

    return {"chk": chk, "sav": sav, "cc": cc, "cd": cd}


def _card_cycle(cc: Acct, lo: dt.date, hi: dt.date) -> int:
    """Net charges (purchases minus refunds, never payments) posted in [lo, hi]."""
    return sum(e["c"] for e in cc.ev if lo <= e["p"] <= hi and "AUTOPAY PAYMENT" not in e["d"])


def _build_ledgers(rng: random.Random) -> dict:
    ev = _build_events(rng)
    chk, sav, cc, cd = ev["chk"], ev["sav"], ev["cc"], ev["cd"]

    # Card: statement closes on the 27th and is paid in full on the 22nd of the following month from checking, so the
    # balance owed today = charges posted since the Sep-27 close (Oct statement + current cycle).
    unpaid_from = dt.date(2026, 9, 28)
    w_fixed = sum(e["c"] for e in cc.ev if not e["flex"] and e["p"] >= unpaid_from)
    # Hit the owed balance exactly: nudge the random charges by <= ~15% and let Amazon/Target orders absorb the rest.
    # (If a seed makes the window too heavy, drop its largest random charge until there is room.)
    while True:
        w_flex = [e for e in cc.ev if e["flex"] and e["p"] >= unpaid_from]
        flex_sum = sum(e["c"] for e in w_flex)
        f_card = min(1.15, max(0.85, (CARD_OWED * 100 - w_fixed - 10000) / flex_sum))
        plug = CARD_OWED * 100 - w_fixed - int(round(flex_sum * f_card))
        if plug >= 2500:
            break
        cc.ev.remove(max(w_flex, key=lambda e: e["c"]))
    for e in w_flex:
        e["c"] = int(round(e["c"] * f_card))
    plug = CARD_OWED * 100 - w_fixed - sum(e["c"] for e in w_flex)
    parts = 1 if plug <= 45000 else 2
    sfx = "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
    cc.add(dt.date(2026, 10, 18), f"AMAZON.COM*{sfx} AMZN.COM/BILL WA", plug - (plug // 2 if parts == 2 else 0), lag=2)
    if parts == 2:
        cc.add(dt.date(2026, 10, 15), "TARGET T-1184 PLANO TX", plug // 2, lag=1)

    PRE_HISTORY = {5: 134219, 6: 41055}            # May-22 payment pays the April statement; Jun-22 payment includes Apr28-May7
    payments = {}
    for y, m in months():
        if m > 10:
            continue
        pay_day = next_biz(dt.date(y, m, 22))
        if m == 5:
            amt = PRE_HISTORY[5]
        else:
            py, pm = (y, m - 1)
            lo = dt.date(py, pm - 1, 28)
            hi = dt.date(py, pm, 27)
            amt = _card_cycle(cc, lo, hi) + (PRE_HISTORY[6] if m == 6 else 0)
        payments[m] = (pay_day, amt)
        chk.add(pay_day, "LONESTAR CARD AUTOPAY", amt, p=pay_day)
        cc.add(pay_day, "AUTOPAY PAYMENT THANK YOU", -amt, p=pay_day)
    oct_stmt = _card_cycle(cc, dt.date(2026, 9, 28), dt.date(2026, 10, 27))
    last_payment = payments[10][1]

    # Checking: rescale the discretionary debit spending so the window's net cash flow hits the target.
    net_in = -sum(e["c"] for e in chk.ev)
    flex = [e for e in chk.ev if e["flex"]]
    f_chk = _rescale(flex, sum(e["c"] for e in flex) + (net_in - CHECKING_NET_TARGET), 0.7, 1.5, "checking cash flow")

    return {"chk": chk, "sav": sav, "cc": cc, "cd": cd, "oct_stmt": oct_stmt, "last_payment": last_payment,
            "scale": {"card": round(f_card, 3), "checking": round(f_chk, 3)}}


# ----------------------------------------------------------------------------------------------------- investments


def _ira(rng: random.Random, contributions: list[dt.date]) -> tuple[list[dict], list[dict]]:
    asof = HIST_END.isoformat()
    spec = [("VTI", "Vanguard Total Stock Market ETF", 336.20, 48400),
            ("VXUS", "Vanguard Total International Stock ETF", 78.40, 17600),
            ("BND", "Vanguard Total Bond Market ETF", 73.85, 13200),
            ("SCHD", "Schwab U.S. Dividend Equity ETF", 29.15, None)]
    holdings, running = [], 0.0
    for i, (tick, name, price, target) in enumerate(spec):
        qty = round(target / price, 4) if target else round((IRA_BALANCE - running) / price, 4)
        value = qty * price
        running += value
        holdings.append({
            "institution_price": price, "institution_price_as_of": asof,
            "cost_basis": round(value * rng.uniform(0.74, 0.88), 2), "quantity": qty, "currency": "USD",
            "security": {"ticker_symbol": tick, "name": name, "currency": "USD"}})
    assert abs(running - IRA_BALANCE) < 1.0, running
    px = {5: 318.40, 6: 322.15, 7: 324.80, 8: 327.40, 9: 330.05, 10: 332.10, 11: 336.20}
    buys = []
    for d in contributions:
        p = px[d.month]
        buys.append({"date": d.isoformat(), "name": "BUY VTI", "quantity": round(IRA_CONTRIBUTION / 100 / p, 4),
                     "price": p, "fees": 0, "type": "buy", "currency": "USD",
                     "security": {"ticker_symbol": "VTI", "name": "Vanguard Total Stock Market ETF", "currency": "USD"}})
    return holdings, buys


# ---------------------------------------------------------------------------------------------------- loan amortization


def _auto_loan_terms() -> dict:
    """60-month, $455/mo, 7.45% fixed, 25 payments made (first 2024-11-05, last 2026-11-05) leaving ~$14,300."""
    r = 0.0745 / 12
    n_paid = 25
    pmt = AUTO_PAYMENT / 100
    p0 = (AUTO_BALANCE + pmt * ((1 + r) ** n_paid - 1) / r) / (1 + r) ** n_paid
    bal, ytd = p0, 0.0
    for k in range(n_paid):                                   # payment k happens on month index k from 2024-11
        interest = bal * r
        year = 2024 + (10 + k) // 12
        if year == 2026:
            ytd += interest
        bal = bal + interest - pmt
    return {"p0": round(p0, 2), "ytd_interest": round(ytd, 2), "remaining_calc": round(bal, 2), "rate": 7.45}


# ---------------------------------------------------------------------------------------------------- the builder


def build_sandbox_user(seed: int = 2026) -> dict:
    """Return the Plaid custom-user configuration dict (JSON-serialisable, deterministic for a given seed)."""
    rng = random.Random(f"keystone:{seed}:plaid_user")
    led = _build_ledgers(rng)

    def acct_no(mask: str) -> str:
        return f"88{rng.randrange(10 ** 6):06d}{mask}"

    # IRA buys land the business day after each checking contribution posts
    contribs = sorted({next_biz(e["p"] + ONE) for e in led["chk"].ev
                       if e["d"] == "LONESTAR INVESTMENTS IRA CONTRIBUTION" and next_biz(e["p"] + ONE) <= HIST_END})
    holdings, buys = _ira(rng, contribs)

    identity = {
        "names": ["Daniel Whitfield", "Maya Whitfield"],
        "phone_numbers": [{"data": "2145550142", "primary": True, "type": "mobile"}],
        "emails": [{"data": "whitfield.family@example.com", "primary": True, "type": "primary"}],
        "addresses": [{"primary": True, "data": {"street": "4417 Larkspur Court", "city": "Plano", "region": "TX",
                                                 "postal_code": "75093", "country": "US"}}],
    }

    checking = {
        "type": "depository", "subtype": "checking", "starting_balance": CHECKING_BALANCE,
        "force_available_balance": CHECKING_BALANCE,
        "meta": {"name": "Everyday Checking", "official_name": "Lonestar Everyday Checking", "mask": "0001"},
        "numbers": {"account": acct_no("0001"), "ach_routing": "322271627"},
        "identity": identity,
        "transactions": led["chk"].rows(),
    }
    savings = {
        "type": "depository", "subtype": "savings", "starting_balance": SAVINGS_BALANCE,
        "force_available_balance": SAVINGS_BALANCE,
        "meta": {"name": "High-Yield Savings", "official_name": "Lonestar High-Yield Savings", "mask": "0002", "apy": 4.1},
        "numbers": {"account": acct_no("0002"), "ach_routing": "322271627"},
        "transactions": led["sav"].rows(),
    }
    card = {
        "type": "credit", "subtype": "credit card", "starting_balance": CARD_OWED,
        "force_available_balance": CARD_LIMIT - CARD_OWED,
        "meta": {"name": "Rewards Visa", "official_name": "Lonestar Rewards Visa Signature", "mask": "0003", "limit": CARD_LIMIT},
        "transactions": led["cc"].rows(),
        "liability": {"type": "credit", "purchase_apr": CARD_PURCHASE_APR, "cash_apr": 29.9, "balance_transfer_apr": CARD_PURCHASE_APR,
                      "special_apr": 0, "last_payment_amount": money(led["last_payment"]),
                      "last_statement_balance": money(led["oct_stmt"]), "minimum_payment_amount": 35, "is_overdue": False},
    }
    mortgage = {      # NO liability block: Plaid's custom sandbox does not support mortgage liabilities
        "type": "loan", "subtype": "mortgage", "starting_balance": MORTGAGE_BALANCE,
        "meta": {"name": "Home Mortgage", "official_name": "Lonestar 30-Year Fixed Home Loan", "mask": "0004"},
        "transactions": [],
    }
    al = _auto_loan_terms()
    auto = {
        "type": "loan", "subtype": "auto", "starting_balance": AUTO_BALANCE,
        "meta": {"name": "Auto Loan", "official_name": "Lonestar Auto Loan 60-Month", "mask": "0005"},
        "transactions": [],
    }
    if AUTO_LOAN_LIABILITY:
        auto["liability"] = {
            "type": "loan", "interest_rate": {"percentage": al["rate"], "type": "fixed"},
            "principal_balance": AUTO_BALANCE, "origination_principal_amount": al["p0"], "origination_date": "2024-10-05",
            "loan_term_months": 60, "maturity_date": "2029-10-05", "payment_count": 60, "payment_frequency": "monthly",
            "next_payment_amount": money(AUTO_PAYMENT), "next_payment_due_date": "2026-12-05",
            "last_payment_amount": money(AUTO_PAYMENT), "last_payment_date": "2026-11-05",
            "payoff_amount": round(AUTO_BALANCE + AUTO_BALANCE * al["rate"] / 36500 * 2, 2),     # + 2 days of accrued interest
            "ytd_interest_paid": al["ytd_interest"], "compounding_period": "monthly"}
    ira = {
        "type": "investment", "subtype": "ira", "starting_balance": IRA_BALANCE,
        "meta": {"name": "Traditional IRA", "official_name": "Lonestar Self-Directed Traditional IRA", "mask": "0006"},
        "holdings": holdings, "investment_transactions": buys,
    }
    cd = {
        "type": "depository", "subtype": "cd", "starting_balance": CD_BALANCE,
        "meta": {"name": "24-Month CD", "official_name": "Lonestar 24-Month Certificate of Deposit", "mask": "0007", "apy": 4.6},
        "numbers": {"account": acct_no("0007"), "ach_routing": "322271627"},
        "transactions": led["cd"].rows(),
    }
    cfg = {"seed": f"whitfield-family-{seed}", "roll_dates_forward": ROLL_DATES_FORWARD,
           "override_accounts": [checking, savings, card, mortgage, auto, ira, cd]}
    validate(cfg)
    return cfg


# ----------------------------------------------------------------------------------------------- output + validation


def to_override_password(cfg: dict) -> str:
    """Compact JSON string to pass as options.override_password (with override_username 'user_custom')."""
    return json.dumps(cfg, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


_ONE_LINE = {"meta", "numbers", "liability", "identity"}
_ROW_LISTS = {"transactions", "investment_transactions", "holdings"}


def _j(o) -> str:
    return json.dumps(o, separators=(", ", ": "), ensure_ascii=True, allow_nan=False)


def _dump(o, lvl: int = 0, key: str | None = None) -> str:
    pad, end = "  " * (lvl + 1), "  " * lvl
    if isinstance(o, dict):
        if key in _ONE_LINE or not o:
            return _j(o)
        body = ",\n".join(f"{pad}{json.dumps(k)}: {_dump(v, lvl + 1, k)}" for k, v in o.items())
        return "{\n" + body + "\n" + end + "}"
    if isinstance(o, list):
        if not o:
            return "[]"
        if key in _ROW_LISTS:
            return "[\n" + ",\n".join(pad + _j(x) for x in o) + "\n" + end + "]"
        return "[\n" + ",\n".join(pad + _dump(x, lvl + 1) for x in o) + "\n" + end + "]"
    return _j(o)


def dump_config(cfg: dict) -> str:
    """Readable layout: one account key per line, one transaction/holding per line."""
    return _dump(cfg) + "\n"


def _daily_balances(rows: list[dict], start: float, *, end_state: bool, owed: bool) -> list[float]:
    """Balance after each posting day. end_state: `start` is the balance today; else the balance before the first row.
    Plaid sign: amount>0 lowers a depository balance / raises an owed balance."""
    by_day: dict[str, float] = {}
    for r in rows:
        by_day[r["date_posted"]] = by_day.get(r["date_posted"], 0.0) + r["amount"]
    days = sorted(by_day)
    sgn = 1.0 if owed else -1.0                       # effect of +amount on the balance
    if not end_state:
        bal, out = start, []
        for d in days:
            bal += sgn * by_day[d]
            out.append(bal)
        return out
    bal, out = start, [start]
    for d in reversed(days):
        bal -= sgn * by_day[d]
        out.append(bal)
    return out


def validate(cfg: dict) -> dict:
    assert set(cfg) <= {"seed", "roll_dates_forward", "override_accounts"}, cfg.keys()
    assert isinstance(cfg["seed"], str)
    accts = cfg["override_accounts"]
    assert 1 <= len(accts) <= 10, "Plaid: more than ten accounts fails"
    lo, hi = HIST_START.isoformat(), HIST_END.isoformat()
    total_tx, stats = 0, {}
    masks = set()
    for a in accts:
        t, st = a["type"], a["subtype"]
        assert st in VALID_PAIRS.get(t, ()), f"invalid type/subtype {t}/{st}"
        assert not ("force_available_balance" in a and a.get("has_null_available_balance"))
        mask = a["meta"]["mask"]
        assert len(mask) in (2, 3, 4) and mask.isalnum() and mask not in masks, mask
        masks.add(mask)
        for k in ("starting_balance", "force_available_balance"):
            if k in a:
                assert isinstance(a[k], (int, float)) and abs(a[k]) < 1e9
        if "numbers" in a:
            assert set(a["numbers"]) <= {"account", "ach_routing", "ach_wire_routing"}
            ar = a["numbers"]["ach_routing"]
            d9 = [int(ch) for ch in ar]
            assert len(d9) == 9 and (3 * (d9[0] + d9[3] + d9[6]) + 7 * (d9[1] + d9[4] + d9[7]) + (d9[2] + d9[5] + d9[8])) % 10 == 0
            assert a["numbers"]["account"].endswith(mask)
        if "liability" in a:
            L = a["liability"]
            assert set(L) <= LIABILITY_KEYS[L["type"]], set(L) - LIABILITY_KEYS[L["type"]]
            assert (t, L["type"]) in {("credit", "credit"), ("loan", "loan")}
            assert st != "mortgage", "Plaid custom sandbox does not support mortgage liabilities"
        rows = a.get("transactions", [])
        seen, prev = set(), None
        for r in rows:
            assert list(r) == TX_KEYS, r
            assert r["currency"] == "USD" and isinstance(r["amount"], (int, float)) and abs(r["amount"]) < 1e7
            assert lo <= r["date_transacted"] <= r["date_posted"] <= hi, r
            key = (r["date_transacted"], r["description"], r["amount"])
            assert key not in seen, f"duplicate transaction {key}"
            seen.add(key)
            cur = (r["date_transacted"], r["date_posted"])
            assert prev is None or cur >= prev, "transactions must be ascending"
            prev = cur
        inv = a.get("investment_transactions", [])
        assert [x["date"] for x in inv] == sorted(x["date"] for x in inv)
        assert all(lo <= x["date"] <= hi and x["quantity"] > 0 and x["type"] == "buy" for x in inv)
        if "holdings" in a:
            val = sum(h["quantity"] * h["institution_price"] for h in a["holdings"])
            assert abs(val - a["starting_balance"]) < 1.0, val
            assert all(h["institution_price_as_of"] <= hi for h in a["holdings"])
        total_tx += len(rows) + len(inv)
        stats[mask] = (t, st, len(rows) + len(inv))

    # --- reconciliation / believability
    by_mask = {a["meta"]["mask"]: a for a in accts}
    chk, sav, cc = by_mask["0001"], by_mask["0002"], by_mask["0003"]
    net = {}
    for name, a in (("checking", chk), ("savings", sav)):
        net[name] = -sum(r["amount"] for r in a["transactions"])
        for end_state in (True, False):
            lo_bal = min(_daily_balances(a["transactions"], a["starting_balance"], end_state=end_state, owed=False))
            floor = 2000 if name == "checking" else 10000
            assert lo_bal >= floor, f"{name} balance dips to {lo_bal:.2f} (end_state={end_state})"
    assert abs(net["checking"] - CHECKING_NET_TARGET / 100) < 0.5, net
    income = -sum(r["amount"] for r in chk["transactions"] if r["amount"] < 0 and "PAYROLL" in r["description"])
    assert 7600 <= income / (6.0) <= 8300, income / 6.0                        # ~ $7.9k / month net, two earners
    owed_w = sum(r["amount"] for r in cc["transactions"]                       # charges since the Sep-27 close are unpaid
                 if r["date_posted"] >= "2026-09-28" and "AUTOPAY PAYMENT" not in r["description"])
    assert abs(owed_w - cc["starting_balance"]) < 0.005, owed_w                # ... and equal the balance owed
    for end_state in (True, False):
        bals = _daily_balances(cc["transactions"], cc["starting_balance"], end_state=end_state, owed=True)
        assert 0 <= min(bals) and max(bals) <= cc["meta"]["limit"] * 0.75, (min(bals), max(bals), end_state)
    card_pays = sorted(-r["amount"] for r in cc["transactions"] if "AUTOPAY" in r["description"])
    chk_pays = sorted(r["amount"] for r in chk["transactions"] if r["description"] == "LONESTAR CARD AUTOPAY")
    assert len(card_pays) == 6 and card_pays == chk_pays and all(x > 0 for x in card_pays)     # both legs of each payment
    sav_in = [r for r in sav["transactions"] if r["description"].startswith("ONLINE TRANSFER FROM CHECKING")]
    chk_out = [r for r in chk["transactions"] if r["description"].startswith("ONLINE TRANSFER TO SAVINGS")]
    assert len(sav_in) == len(chk_out) >= 6 and all(a["amount"] == -b["amount"] and a["date_posted"] == b["date_posted"]
                                                    for a, b in zip(sav_in, chk_out))
    assert total_tx <= MAX_TX, f"{total_tx} transactions (> {MAX_TX})"
    compact = len(to_override_password(cfg).encode())
    assert compact <= MAX_COMPACT_BYTES, compact
    assert len(dump_config(cfg).encode()) <= MAX_FILE_BYTES
    assert dump_config(cfg).isascii()
    assert json.loads(dump_config(cfg)) == cfg
    return {"total_tx": total_tx, "stats": stats, "net": net, "compact": compact, "owed_w": owed_w}


def main() -> None:
    cfg = build_sandbox_user(2026)
    text = dump_config(cfg)
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    info = validate(json.loads(text))
    all_dates = [r[k] for a in cfg["override_accounts"] for r in a.get("transactions", []) for k in ("date_transacted", "date_posted")]
    all_dates += [x["date"] for a in cfg["override_accounts"] for x in a.get("investment_transactions", [])]
    print(f"wrote {os.path.relpath(OUT_PATH, os.getcwd())}")
    print(f"top-level keys: {', '.join(cfg)}   roll_dates_forward={cfg['roll_dates_forward']}   seed={cfg['seed']!r}")
    print(f"{'acct':<6}{'type/subtype':<24}{'balance':>12}{'txns':>6}  keys")
    for a in cfg["override_accounts"]:
        n = len(a.get("transactions", [])) + len(a.get("investment_transactions", []))
        print(f"{a['meta']['mask']:<6}{a['type'] + '/' + a['subtype']:<24}{a['starting_balance']:>12,.2f}{n:>6}  {','.join(a)}")
    print(f"total transactions: {info['total_tx']} (cap {MAX_TX}; Plaid ~250)   dates {min(all_dates)} .. {max(all_dates)}")
    print(f"checking net flow {info['net']['checking']:+,.2f}  savings net flow {info['net']['savings']:+,.2f}  "
          f"card unpaid charges {info['owed_w']:,.2f}")
    print(f"size: file {len(text.encode()) / 1024:.1f} KB, compact override_password {info['compact'] / 1024:.1f} KB (Plaid ~55 KB limit)")


if __name__ == "__main__":
    sys.exit(main())
