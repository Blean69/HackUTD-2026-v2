#!/usr/bin/env python3
"""PNC's HackUTD 2026 synthetic customers -> Plaid Sandbox *custom users* (selectable "bank profiles" for the demo bank).

    python data/pnc_profiles.py          # reads data/pnc/raw/*.csv, writes data/plaid/profiles/{pnc_cNNN,index}.json
    python data/pnc_profiles.py --check  # build in memory and run the validators only (writes nothing)
    python data/pnc_profiles.py --list   # also print every profile id, transaction count and display name
    python data/pnc_profiles.py --out DIR  # DIR plays the role of data/plaid (reads DIR/sandbox_user.json, writes DIR/profiles/)

Source (Apache-2.0, vendored in data/pnc/raw/, see data/pnc/README.md): github.com/devfulcrum/pnc-utd-hackathon-2026,
Lab_Package/data/ (30 synthetic customers, 196 accounts, 24 months of ledger, 2024-11-01 .. 2026-10-31).
`generate.py` runs this after `plaid_user.py`. Standard library only; deterministic (no random module, no hash(): every
"random" choice is a sha256 of stable keys), byte-identical output on every run.

Output format = Plaid's custom-user JSON (https://plaid.com/docs/sandbox/user-custom/, checked Nov 2026), passed to
/sandbox/public_token/create as options.override_username = "user_custom", options.override_password = <JSON string>.

What was checked live against the Plaid Sandbox (Nov 2026), and therefore what this file does
---------------------------------------------------------------------------------------------
* starting_balance IS the current balance (/accounts/get returns it verbatim; transactions never move it). We therefore put
  PNC's closing balance (accounts.csv, as of 2026-10-31) there. Credit/loan balances are the positive amount owed.
* Sign convention: positive amount = money out of a deposit account / a charge on a card; negative = paycheck, transfer in,
  refund, card payment. PNC stores `balance_change` (signed change of THAT account's balance), so:
      deposit accounts   amount = -balance_change        (a deposit is negative)
      credit card        amount = +balance_change        (a purchase raises the balance owed, a payment lowers it)
* Limits (docs): "approximately 250 transactions", "approximately 55kb", "more than ten accounts" are unsupported. We keep
  <= MAX_TX (240) transactions and <= MAX_COMPACT_BYTES (50 kB). PNC customers have 5-8 accounts (all fine).
* WINDOW: the most recent N whole calendar months per customer, N = 6 (2026-05 .. 2026-10), lowered to 5, 4 or 3 only if a
  customer would exceed the caps. With 23-32 rows a month every customer fits 6 months (136-191 rows, 24-29 kB).
* Dates are shifted by one constant (SHIFT_DAYS) so PNC's last day (2026-10-31) becomes 2026-11-06, "yesterday" like the
  family profile; every interval is preserved. roll_dates_forward is true, so Plaid also re-anchors the newest activity to
  the day the Item is created. NOTE: the worker must request days_requested >= 365; with 180 Plaid silently drops the
  first ~10 days of a 6-month window (verified: a 2026-05-01 row vanished at 180, was returned at 365).
* Loan accounts (mortgage, auto, personal) carry their ledger (payment received, interest charge, servicing fee) but NO
  `liability` block: any `loan` liability block (any subtype) makes Plaid answer INTERNAL_SERVER_ERROR when `liabilities`
  is among initial_products; a `student` block is accepted but Plaid replaces the account with random data; mortgages are
  unsupported by the docs. Plaid returns transactions for loan accounts (checked), and the loan-side legs are what lets the
  SpacetimeDB net-worth math cancel a checking-to-loan payment, exactly like the loan-account side in data/seed. APR and
  scheduled payment are exposed in the index preview (rate_pct, monthly_payment) because Plaid cannot carry them.
* IRA: investment/ira with `holdings` (ETFs whose value sums to the balance); no investment_transactions (the worker does not
  read them and they would eat the 250 cap). Credit card: `liability` block (type credit) works and is used: APR from
  accounts.csv, minimum payment = PNC's scheduled monthly_payment, last statement balance from monthly_statements.csv.
* Subtypes (all verified accepted): depository/checking|savings|cd, credit/credit card, loan/auto|mortgage|consumer,
  investment/ira. PNC "personal_loan" -> Plaid loan/consumer (Plaid's own "Consumer loan"; there is no "personal" subtype).

Transaction text: PNC's ledger only says "Payment" / "Withdrawal" / "Purchase" plus a category, so each row gets a realistic
bank-statement descriptor chosen deterministically from its category (real national and Texas brands, fictional employers,
landlords and banks), because Plaid's own enrichment (merchant name, personal_finance_category) is derived from the text.
Amounts, dates, signs, and the pairing of transfer legs are exactly PNC's. One PNC row = one Plaid row.

Personas: PNC's profiles.csv has only monthly_income, monthly_non_debt_expenses and credit_limit. The friendly first name,
occupation and life-stage words are fictional storytelling picked deterministically from those numbers plus the balances
(see _persona); they are not PNC fields.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plaid_user import LIABILITY_KEYS, TX_KEYS, VALID_PAIRS, dump_config, to_override_password  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "pnc", "raw")
PLAID_DIR = os.path.join(HERE, "plaid")
OUT_DIR = os.path.join(PLAID_DIR, "profiles")

ANCHOR_END = dt.date(2026, 11, 6)       # PNC's last day lands here ("yesterday" relative to the repo's fixed today, 2026-11-07)
MAX_MONTHS, MIN_MONTHS = 6, 3
MAX_TX = 240                            # Plaid: ~250 transactions in total
MAX_COMPACT_BYTES = 50_000              # Plaid: ~55 kB
MAX_ACCOUNTS = 10
TX_KINDS = ("checking", "savings", "cd", "credit_card", "auto_loan", "personal_loan", "mortgage")   # account kinds that carry transactions (all but the IRA)
DEBT_KINDS = ("credit_card", "auto_loan", "personal_loan", "mortgage")

# PNC account_type -> (Plaid type, Plaid subtype, display name, official name)
PLAID_KIND = {
    "checking": ("depository", "checking", "Everyday Checking", "Everyday Checking"),
    "savings": ("depository", "savings", "Savings", "Statement Savings"),
    "cd": ("depository", "cd", "Certificate of Deposit", "Fixed-Term Certificate of Deposit"),
    "ira": ("investment", "ira", "Traditional IRA", "Self-Directed Traditional IRA"),
    "credit_card": ("credit", "credit card", "Rewards Visa", "Rewards Visa Signature"),
    "auto_loan": ("loan", "auto", "Auto Loan", "Fixed-Rate Auto Loan"),
    "personal_loan": ("loan", "consumer", "Personal Loan", "Fixed-Rate Personal Loan"),
    "mortgage": ("loan", "mortgage", "Home Mortgage", "Fixed-Rate Home Loan"),
}
ACCOUNT_ORDER = ["checking", "savings", "cd", "credit_card", "auto_loan", "personal_loan", "mortgage", "ira"]

ETFS = {  # ticker -> (name, price on 2026-11-06); same prices as the family profile
    "VTI": ("Vanguard Total Stock Market ETF", 336.20),
    "VXUS": ("Vanguard Total International Stock ETF", 78.40),
    "BND": ("Vanguard Total Bond Market ETF", 73.85),
}

FIRST_NAMES = ["Maya", "Marcus", "Elena", "Darius", "Priya", "Tomas", "Aaliyah", "Wei", "Grace", "Omar",
               "Sofia", "Jamal", "Hannah", "Luis", "Keiko", "Andre", "Nora", "Kwame", "Isabel", "Ravi",
               "Tessa", "Mateo", "Leila", "Caleb", "Imani", "Noah", "Camila", "Devon", "Anika", "Ben"]
JOBS = {  # by monthly income band (upper bound exclusive)
    4500: ["home health aide", "warehouse lead", "retail supervisor", "line cook", "delivery driver"],
    7500: ["teacher", "dental hygienist", "electrician", "paralegal", "customer-success rep"],
    11000: ["nurse practitioner", "project manager", "accountant", "civil engineer", "pharmacist"],
    10 ** 9: ["software engineer", "dentist", "sales director", "attorney", "physician assistant"],
}
EMPLOYERS = ["NORTHBRIDGE LOGISTICS", "LONE STAR HEALTH SYSTEM", "TRINITY RIVER SCHOOLS", "CEDAR RIDGE SOFTWARE",
              "BLUEBONNET DENTAL GROUP", "OAKLINE CONSTRUCTION", "METRO TRANSIT AUTHORITY", "PRAIRIE STATE ENERGY",
              "WHITE ROCK ANALYTICS", "LAKEWOOD MEDICAL GROUP", "SUMMIT RETAIL HOLDINGS", "CANYON CREEK MANUFACTURING",
              "BRAZOS VALLEY FOODS", "REDBIRD CONSULTING", "COPPER STATE ENGINEERING", "HEARTLAND PHARMACY"]
CITIES = ["PLANO TX", "DALLAS TX", "FRISCO TX", "IRVING TX", "RICHARDSON TX", "GARLAND TX", "ARLINGTON TX", "MCKINNEY TX"]
LANDLORDS = ["ELM STREET APARTMENTS", "OAK CLIFF LOFTS", "MAPLE COURT RESIDENCES", "LAKESIDE FLATS", "BRIDGEWATER APTS", "CEDAR POINT PROPERTIES"]
GROCERY = ["HEB #{n} {c}", "KROGER #{n} {c}", "TOM THUMB #{n} {c}", "WHOLE FOODS MKT #{n} {c}", "WALMART SUPERCENTER #{n} {c}", "ALDI {n} {c}", "COSTCO WHSE #{n} {c}"]
TRANSPORT = ["SHELL SERVICE STATION {c}", "QUIKTRIP #{n} {c}", "EXXONMOBIL {c}", "CHEVRON {n} {c}", "UBER *TRIP HELP.UBER.COM", "DART TRANSIT PASS {c}", "COSTCO GAS #{n} {c}"]
DINING = ["CHIPOTLE {n} {c}", "TORCHYS TACOS {c}", "STARBUCKS STORE {n} {c}", "CHICK-FIL-A #{n} {c}", "OLIVE GARDEN {n} {c}", "WHATABURGER #{n} {c}", "CHILIS GRILL & BAR {c}", "DOORDASH*ORDER"]
SHOPPING = ["TARGET T-{n} {c}", "AMAZON.COM*{n}", "BEST BUY #{n} {c}", "OLD NAVY #{n} {c}", "THE HOME DEPOT #{n} {c}", "WALGREENS #{n} {c}", "IKEA FRISCO TX"]
OTHER_SPEND = ["AMAZON.COM*{n}", "TARGET T-{n} {c}", "COSTCO WHSE #{n} {c}", "WALGREENS #{n} {c}", "LOWES #{n} {c}", "PETSMART #{n} {c}", "ZELLE PAYMENT SENT"]
SAVINGS_SPEND = ["ZELLE PAYMENT SENT", "ONLINE PAYMENT TO HOME CONTRACTOR", "ACH DEBIT THE HOME DEPOT", "ACH DEBIT BEST BUY", "ACH DEBIT STATE FARM INSURANCE"]
UTILITIES = ["TXU ENERGY AUTOPAY", "ATMOS ENERGY BILL PAY", "SPECTRUM INTERNET AUTOPAY", "VERIZON WIRELESS AUTOPAY", "CITY OF {cityname} UTILITIES WATER", "AT&T INTERNET AUTOPAY"]


# ------------------------------------------------------------------------------------------------------- tiny helpers


def _h(*parts) -> int:
    """Deterministic 'random' integer from stable keys (never Python's per-process hash())."""
    return int(hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:12], 16)


def _pick(options: list[str], *key) -> str:
    return options[_h("pnc", *key) % len(options)]


def money(x: float) -> int | float:
    r = round(x + 1e-9, 2)
    return int(r) if r == int(r) else r


def fmt_k(x: float) -> str:
    return f"${x / 1000:.1f}k" if abs(x) >= 1000 else f"${x:,.0f}"


def _shift(d: str, days: int) -> str:
    return (dt.date.fromisoformat(d) + dt.timedelta(days=days)).isoformat()


def _read(name: str) -> list[dict]:
    with open(os.path.join(RAW_DIR, name), newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


class Customer:
    """One PNC customer: profile row, accounts by type, ledger rows, monthly statements."""

    def __init__(self, cid: str, profile: dict, accounts: list[dict], txns: list[dict], stmts: list[dict]) -> None:
        self.id = cid
        self.income = float(profile["monthly_income"])
        self.expenses = float(profile["monthly_non_debt_expenses"])
        self.credit_limit = float(profile["credit_limit"])
        self.accounts = {a["account_type"]: a for a in accounts}
        self.txns = txns
        self.stmts = {(s["account_id"], s["month"]): s for s in stmts}
        self.index = int(cid[1:]) - 1
        self.slug = f"pnc_{cid.lower()}"
        self._masks: dict[str, str] = {}
        for k in ACCOUNT_ORDER:
            if k in self.accounts:
                m = _h("mask", self.accounts[k]["account_id"]) % 9000 + 1000
                while str(m) in self._masks.values():
                    m = m % 9000 + 1001
                self._masks[k] = str(m)

    def bal(self, kind: str) -> float:
        return float(self.accounts[kind]["balance"]) if kind in self.accounts else 0.0

    def mask(self, kind: str) -> str:
        """Stable 4-digit mask per account, unique inside a customer."""
        return self._masks[kind]


# ------------------------------------------------------------------------------------------------- descriptors


def _store(pool: list[str], cust: Customer, row: dict, salt: str) -> str:
    k = (cust.id, row["transaction_id"], salt)
    city = CITIES[_h("city", cust.id) % len(CITIES)]        # one home town per customer
    return _pick(pool, *k).format(n=100 + _h("store", *k) % 900, c=city, cityname=city[:-3])


def describe(cust: Customer, row: dict) -> str:
    """A realistic bank-statement descriptor for one PNC ledger row (deterministic)."""
    acct, ttype, cat, native = row["account_type"], row["transaction_type"], row["category"], row["description"]
    employer = EMPLOYERS[_h("employer", cust.id) % len(EMPLOYERS)]
    m = {k: cust.mask(k) for k in cust.accounts}
    month_no = int(row["posted_date"][5:7]) + 12 * (int(row["posted_date"][:4]) - 2024)
    if acct == "checking":
        if cat == "payroll":
            return f"{'DIRECT DEP' if _h('style', cust.id) % 2 else 'ACH CREDIT'} {employer} PAYROLL"
        if cat == "housing":
            if "mortgage" in cust.accounts:
                return "PROPERTY TAX AND HOMEOWNERS INSURANCE"
            return f"RENT PAYMENT {LANDLORDS[_h('landlord', cust.id) % len(LANDLORDS)]}"
        if cat == "utilities":
            return UTILITIES[(_h("util", cust.id) + month_no) % len(UTILITIES)].format(cityname=CITIES[_h("city", cust.id) % len(CITIES)][:-3])
        if cat == "groceries":
            return _store(GROCERY, cust, row, "chk")
        if cat == "other_spending":
            return _store(OTHER_SPEND, cust, row, "chk")
        if cat == "savings_contribution":
            return f"ONLINE TRANSFER TO SAVINGS {m['savings']}"
        if cat == "savings_withdrawal":
            return f"ONLINE TRANSFER FROM SAVINGS {m['savings']}"
        if cat == "investment_contribution":
            if "linked ira" in native:
                return f"IRA CONTRIBUTION ONLINE TRANSFER {m['ira']}"
            if "linked cd" in native:
                return f"ONLINE TRANSFER TO CD {m['cd']}"
            return f"ONLINE TRANSFER TO SAVINGS {m['savings']}"          # "savings deposit rounding" is filed under investment_contribution
        if cat == "debt_payment":
            kind = native.replace("Synthetic linked ", "").replace(" payment", "").replace(" ", "_")   # credit_card, personal_loan, ...
            label = {"credit_card": "CREDIT CARD AUTOPAY PAYMENT", "personal_loan": "PERSONAL LOAN PAYMENT", "mortgage": "MORTGAGE PAYMENT", "auto_loan": "AUTO LOAN PAYMENT"}[kind]
            return f"{label} XXXX{m[kind]}"
        if cat == "external_cash_management":
            ext = 1000 + _h("ext", cust.id) % 9000
            return f"ACH TRANSFER {'TO' if ttype == 'withdrawal' else 'FROM'} EXTERNAL BROKERAGE XXXX{ext}"
    elif acct == "savings":
        if cat == "payroll":
            return f"DIRECT DEP {employer} PAYROLL SPLIT"
        if cat == "savings_contribution" or cat == "investment_contribution":
            return f"ONLINE TRANSFER FROM CHECKING {m['checking']}"
        if cat == "asset_interest":
            return "INTEREST PAYMENT"
        if cat == "other_spending":
            return _pick(SAVINGS_SPEND, cust.id, row["transaction_id"])
        if cat == "savings_withdrawal":
            return f"ONLINE TRANSFER TO CHECKING {m['checking']}"
    elif acct == "cd":
        return "CD INTEREST CREDIT" if cat == "asset_interest" else f"ONLINE TRANSFER FROM CHECKING {m['checking']}"
    elif acct == "credit_card":
        pools = {"groceries": GROCERY, "transport": TRANSPORT, "dining": DINING, "shopping": SHOPPING}
        if cat in pools:
            return _store(pools[cat], cust, row, "cc")
        if cat == "debt_interest":
            return "PURCHASE INTEREST CHARGE"
        if cat == "card_fee":
            return "LATE PAYMENT FEE"
        if cat == "debt_payment":
            return "PAYMENT THANK YOU ONLINE"
    elif acct in ("auto_loan", "personal_loan", "mortgage"):
        label = {"auto_loan": "AUTO LOAN", "personal_loan": "PERSONAL LOAN", "mortgage": "MORTGAGE"}[acct]
        if cat == "debt_payment":
            return f"PAYMENT RECEIVED {label} XXXX{m[acct]}"
        if cat == "debt_interest":
            return f"{label} INTEREST CHARGE"
        if cat == "servicing_fee":
            return f"{label} SERVICING FEE"
    raise ValueError(f"no descriptor for {acct}/{ttype}/{cat}/{native!r}")


# ----------------------------------------------------------------------------------------------------- the build


def _window_months(all_months: list[str], n: int) -> list[str]:
    return all_months[-n:]


def _tx_rows(cust: Customer, months: list[str], shift: int) -> dict[str, list[dict]]:
    """kind -> Plaid transaction objects for the window, ascending."""
    keep = set(months)
    out: dict[str, list[dict]] = {k: [] for k in TX_KINDS if k in cust.accounts}
    for r in cust.txns:
        if r["account_type"] not in out or r["posted_date"][:7] not in keep:
            continue
        change = float(r["balance_change"])
        amount = change if r["account_type"] in DEBT_KINDS else -change
        posted = _shift(r["posted_date"], shift)
        card_like = (r["account_type"] == "credit_card" and r["transaction_type"] == "purchase") or (r["account_type"] == "checking" and r["category"] in ("groceries", "other_spending"))
        lag = _h("lag", r["transaction_id"]) % 3 if card_like else 0       # transacted 0-2 days before it posts
        out[r["account_type"]].append({
            "date_transacted": _shift(r["posted_date"], shift - lag), "date_posted": posted, "currency": "USD",
            "amount": money(amount), "description": describe(cust, r), "_id": r["transaction_id"],
        })
    for k, rows in out.items():
        rows.sort(key=lambda t: (t["date_transacted"], t["date_posted"], t["_id"]))
    return out


def _holdings(cust: Customer, stage: str, shift: int) -> list[dict]:
    ira = cust.accounts["ira"]
    value = float(ira["balance"])
    deposits = sum(float(r["amount"]) for r in cust.txns if r["account_type"] == "ira" and r["transaction_type"].startswith("deposit"))
    cost_total = float(ira["opening_balance"]) + deposits           # money put in; the rest of the balance is accrued gain
    weights = {"early-career": (0.70, 0.25, 0.05), "mid-career": (0.55, 0.20, 0.25), "late-career": (0.40, 0.15, 0.45)}[stage]
    asof = ANCHOR_END.isoformat()
    holdings, running = [], 0.0
    for (tic, (name, price)), w in zip(ETFS.items(), weights):
        v = round(value * w, 2)
        qty = round(v / price, 4)
        running += qty * price
        holdings.append({"institution_price": price, "institution_price_as_of": asof, "cost_basis": round(cost_total * w, 2), "quantity": qty,
                         "currency": "USD", "security": {"ticker_symbol": tic, "name": name, "currency": "USD"}})
    # the last holding absorbs the rounding so the holdings sum to the balance to within a cent or two
    tic, (name, price) = list(ETFS.items())[-1]
    holdings[-1]["quantity"] = round((value - (running - holdings[-1]["quantity"] * price)) / price, 4)
    return holdings


def _stage(cust: Customer) -> str:
    """Life stage from how much is in the IRA relative to a year of income (a proxy; PNC has no age)."""
    ratio = cust.bal("ira") / (cust.income * 12)
    return "early-career" if ratio < 0.3 else "mid-career" if ratio < 0.9 else "late-career"


def _metrics(cust: Customer) -> dict:
    debts = sum(cust.bal(k) for k in ("credit_card", "auto_loan", "personal_loan", "mortgage"))
    pay = sum(float(cust.accounts[k]["monthly_payment"]) for k in ("credit_card", "auto_loan", "personal_loan", "mortgage") if k in cust.accounts)
    liquid = cust.bal("checking") + cust.bal("savings")
    return {
        "debts": debts, "liquid": liquid, "debt_payments": pay,
        "save_rate": (cust.income - cust.expenses - pay) / cust.income,   # what is left after living costs and scheduled debt payments
        "runway": liquid / (cust.expenses + pay), "util": cust.bal("credit_card") / cust.credit_limit,
        "dti": pay / cust.income,
    }


def _persona(cust: Customer) -> dict:
    """First name, life stage, job and a one-line story. Story = first matching rule; every input is a PNC number."""
    m = _metrics(cust)
    stage = _stage(cust)
    job = _pick(next(v for hi, v in JOBS.items() if cust.income < hi), "job", cust.id)
    name = FIRST_NAMES[cust.index]
    mortgage = "mortgage" in cust.accounts
    if m["util"] > 1.0:
        goal = "working off an over-limit credit card"
    elif m["util"] >= 0.75:
        goal = "paying down a nearly maxed-out credit card"
    elif m["save_rate"] < 0 and m["dti"] >= 0.35:
        goal = "buried in debt payments and looking for a plan"
    elif m["save_rate"] < 0:
        goal = "living close to the edge month to month"
    elif m["runway"] < 1.6:
        goal = "building a real emergency fund"
    elif m["dti"] >= 0.20:
        goal = "working down car and personal-loan payments"
    elif not mortgage and m["save_rate"] >= 0.25:
        goal = "saving for a first home"
    elif mortgage and m["save_rate"] >= 0.30:
        goal = "paying the mortgage down fast while investing the rest"
    elif mortgage:
        goal = "balancing the mortgage with retirement saving"
    else:
        goal = "building a steady nest egg"
    return {"name": name, "stage": stage, "job": job, "goal": goal, "display": f"{name}, {stage} {job}, {goal}"}


def build_customer(cust: Customer, months_all: list[str], shift: int, n_months: int) -> dict:
    months = _window_months(months_all, n_months)
    tx = _tx_rows(cust, months, shift)
    persona = _persona(cust)
    accounts = []
    for kind in ACCOUNT_ORDER:
        if kind not in cust.accounts:
            continue
        src = cust.accounts[kind]
        ptype, psub, name, official = PLAID_KIND[kind]
        bal = float(src["balance"])
        meta = {"name": name, "official_name": official, "mask": cust.mask(kind)}
        acct: dict = {"type": ptype, "subtype": psub, "starting_balance": money(bal)}
        if kind == "credit_card":
            limit = cust.credit_limit
            acct["force_available_balance"] = money(max(0.0, limit - bal))
            meta["limit"] = money(limit)
        elif ptype == "depository":
            acct["force_available_balance"] = money(bal)
            if float(src["annual_yield_pct"]) > 0:
                meta["apy"] = float(src["annual_yield_pct"])
        acct["meta"] = meta
        if kind == "credit_card":
            apr = float(src["apr_pct"])
            pays = [t for t in tx["credit_card"] if t["amount"] < 0]
            sid = f"{src['account_id']}"
            prev_month = months_all[-2]
            acct["liability"] = {
                "type": "credit", "purchase_apr": apr, "cash_apr": round(apr + 7.4, 2), "balance_transfer_apr": apr, "special_apr": 0,
                "last_payment_amount": -pays[-1]["amount"] if pays else 0, "last_statement_balance": money(float(cust.stmts[(sid, prev_month)]["closing_balance"])),
                "minimum_payment_amount": money(float(src["monthly_payment"])), "is_overdue": False,
            }
        if kind == "ira":
            acct["holdings"] = _holdings(cust, persona["stage"], shift)
        if kind in tx:
            acct["transactions"] = [{k: t[k] for k in TX_KEYS} for t in tx[kind]]
        accounts.append(acct)
    return {"seed": f"pnc-{cust.id.lower()}-2026", "roll_dates_forward": True, "override_accounts": accounts}


def _sizes(cfg: dict) -> tuple[int, int]:
    n = sum(len(a.get("transactions", [])) for a in cfg["override_accounts"])
    return n, len(to_override_password(cfg).encode())


def build_profile(cust: Customer, months_all: list[str], shift: int) -> tuple[dict, int]:
    """Biggest window (6 months down to 3) whose config fits Plaid's caps."""
    for n in range(MAX_MONTHS, MIN_MONTHS - 1, -1):
        cfg = build_customer(cust, months_all, shift, n)
        count, size = _sizes(cfg)
        if count <= MAX_TX and size <= MAX_COMPACT_BYTES:
            return cfg, n
    raise ValueError(f"{cust.id} does not fit Plaid's caps even with {MIN_MONTHS} months")


# ---------------------------------------------------------------------------------------------------- validation


def validate(cust: Customer, cfg: dict, n_months: int, months_all: list[str], shift: int) -> dict:
    assert set(cfg) == {"seed", "roll_dates_forward", "override_accounts"}
    accts = cfg["override_accounts"]
    assert 1 <= len(accts) <= MAX_ACCOUNTS
    count, size = _sizes(cfg)
    assert count <= MAX_TX and size <= MAX_COMPACT_BYTES, (count, size)
    assert len(dump_config(cfg).encode()) <= 55_000 and dump_config(cfg).isascii() and json.loads(dump_config(cfg)) == cfg
    months = months_all[-n_months:]
    first_day = _shift(f"{months[0]}-01", shift - 2)       # card and debit purchases are transacted up to 2 days before they post
    masks = set()
    for a in accts:
        t, st = a["type"], a["subtype"]
        assert st in VALID_PAIRS[t] or (t, st) == ("loan", "consumer"), (t, st)
        mask = a["meta"]["mask"]
        assert mask.isdigit() and len(mask) == 4 and mask not in masks
        masks.add(mask)
        assert isinstance(a["starting_balance"], (int, float)) and a["starting_balance"] >= 0
        if "liability" in a:
            L = a["liability"]
            assert (t, L["type"]) == ("credit", "credit") and set(L) <= LIABILITY_KEYS["credit"]
        assert not (t == "loan" and "liability" in a), "no loan liability blocks (see module docstring)"
        prev = None
        for r in a.get("transactions", []):
            assert list(r) == TX_KEYS and r["currency"] == "USD"
            assert first_day <= r["date_transacted"] <= r["date_posted"] <= ANCHOR_END.isoformat(), r
            cur = (r["date_transacted"], r["date_posted"])
            assert prev is None or cur >= prev
            prev = cur
        if "holdings" in a:
            val = sum(h["quantity"] * h["institution_price"] for h in a["holdings"])
            assert abs(val - a["starting_balance"]) < 1.0, (val, a["starting_balance"])
    # reconciliation: the window's cash flow explains the move from the first kept month's opening balance to PNC's closing balance
    for a in accts:
        kind = next(k for k, v in PLAID_KIND.items() if v[0] == a["type"] and v[1] == a["subtype"])
        if kind not in TX_KINDS:
            continue
        total = sum(r["amount"] for r in a.get("transactions", []))
        opening = float(cust.stmts[(cust.accounts[kind]["account_id"], months[0])]["opening_balance"])
        end = opening + (total if kind in DEBT_KINDS else -total)
        assert abs(end - a["starting_balance"]) < 0.02, f"{cust.id} {kind}: opening {opening} + flow = {end}, balance {a['starting_balance']}"
    pay_in = -sum(r["amount"] for r in next(a for a in accts if a["subtype"] == "checking")["transactions"] if r["amount"] < 0 and "PAYROLL" in r["description"])
    assert pay_in > 0
    return {"tx": count, "bytes": size}


# --------------------------------------------------------------------------------------------------- the index


def _preview(cust: Customer, cfg: dict) -> list[dict]:
    out = []
    by_kind = {}
    for a in cfg["override_accounts"]:
        kind = next(k for k, v in PLAID_KIND.items() if v[0] == a["type"] and v[1] == a["subtype"])
        by_kind[kind] = a
    for kind in ACCOUNT_ORDER:
        if kind not in by_kind:
            continue
        a = by_kind[kind]
        p = {"name": a["meta"]["name"], "type": a["type"], "subtype": a["subtype"], "mask": a["meta"]["mask"], "balance": a["starting_balance"], "keystone_type": kind}
        src = cust.accounts[kind]
        if float(src["apr_pct"]) > 0:
            p["rate_pct"] = float(src["apr_pct"])
        if float(src["monthly_payment"]) > 0:
            p["monthly_payment"] = float(src["monthly_payment"])
        out.append(p)
    return out


def _entry(cust: Customer, cfg: dict, n_months: int, months_all: list[str], shift: int) -> dict:
    m, pers = _metrics(cust), _persona(cust)
    count = _sizes(cfg)[0]
    window = months_all[-n_months:]
    card = f", card {m['util'] * 100:.0f}% used" if cust.bal("credit_card") else ""
    summary = (f"Earns {fmt_k(cust.income)}/mo and spends {fmt_k(cust.expenses)} before debt payments; {len(cfg['override_accounts'])} accounts, "
               f"{fmt_k(m['liquid'])} in checking and savings, {fmt_k(cust.bal('ira'))} in an IRA, {fmt_k(m['debts'])} of debt{card}.")
    return {
        "profile_id": cust.slug,
        "display_name": pers["display"],
        "summary": summary,
        "accounts": _preview(cust, cfg),
        "txn_count": count,
        "first_name": pers["name"],
        "persona": f"{pers['stage']} {pers['job']}, {pers['goal']}",
        "source": "pnc_hackutd_2026",
        "customer_id": cust.id,
        "monthly_income": money(cust.income),
        "monthly_expenses": money(cust.expenses),
        "cash": money(m["liquid"]),
        "debts": money(m["debts"]),
        "months": n_months,
        "window": {"from": _shift(f"{window[0]}-01", shift), "to": ANCHOR_END.isoformat()},
    }


def _family_entry(family_path: str) -> dict | None:
    if not os.path.exists(family_path):
        return None
    with open(family_path, encoding="utf-8") as f:
        cfg = json.load(f)
    accts = cfg["override_accounts"]
    preview = [{"name": a["meta"]["name"], "type": a["type"], "subtype": a["subtype"], "mask": a["meta"]["mask"], "balance": a["starting_balance"]} for a in accts]
    txn = sum(len(a.get("transactions", [])) for a in accts)
    debts = sum(a["starting_balance"] for a in accts if a["type"] in ("credit", "loan"))
    return {
        "profile_id": "family_demo",
        "display_name": "The Whitfields, a two-income Plano family with a mortgage, car loan and kids' activities",
        "summary": f"The default demo bank: {len(accts)} accounts (checking, savings, card, mortgage, auto loan, IRA, CD), about six months of payroll, bills and groceries; {fmt_k(debts)} of debt.",
        "accounts": preview,
        "txn_count": txn,
        "first_name": "Whitfield family",
        "persona": "two-income family, mortgage and auto loan, saving for the kids",
        "source": "keystone_synthetic",
        "customer_id": "",
        "cash": money(sum(a["starting_balance"] for a in accts if a["type"] == "depository")),
        "debts": money(debts),
    }


def load_customers() -> tuple[list[Customer], list[str], int]:
    profiles = {r["customer_id"]: r for r in _read("profiles.csv")}
    accounts, txns, stmts = _read("accounts.csv"), _read("transactions.csv"), _read("monthly_statements.csv")
    with open(os.path.join(RAW_DIR, "history_manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    as_of = dt.date.fromisoformat(manifest["as_of_date"])
    shift = (ANCHOR_END - as_of).days
    months_all = sorted({s["month"] for s in stmts})
    custs = []
    for cid in sorted(profiles):
        custs.append(Customer(cid, profiles[cid], [a for a in accounts if a["customer_id"] == cid],
                              sorted((t for t in txns if t["customer_id"] == cid), key=lambda t: (t["posted_date"], t["transaction_id"])),
                              [s for s in stmts if s["customer_id"] == cid]))
    return custs, months_all, shift


def build_all(plaid_dir: str = PLAID_DIR) -> tuple[dict[str, dict], list[dict], dict]:
    custs, months_all, shift = load_customers()
    configs, entries, stats = {}, [], {"shift_days": shift, "windows": {}, "tx": {}, "bytes": {}}
    fam = _family_entry(os.path.join(plaid_dir, "sandbox_user.json"))
    if fam:
        entries.append(fam)
    for cust in custs:
        cfg, n = build_profile(cust, months_all, shift)
        info = validate(cust, cfg, n, months_all, shift)
        configs[cust.slug] = cfg
        entries.append(_entry(cust, cfg, n, months_all, shift))
        stats["windows"][cust.slug], stats["tx"][cust.slug], stats["bytes"][cust.slug] = n, info["tx"], info["bytes"]
    return configs, entries, stats


def write_all(configs: dict[str, dict], entries: list[dict], out_dir: str = OUT_DIR) -> None:
    os.makedirs(out_dir, exist_ok=True)
    keep = {f"{k}.json" for k in configs} | {"index.json"}
    for name in os.listdir(out_dir):
        if name.endswith(".json") and name not in keep:
            os.remove(os.path.join(out_dir, name))     # a customer that disappeared from the source must not linger
    for slug, cfg in configs.items():
        with open(os.path.join(out_dir, f"{slug}.json"), "w", encoding="utf-8", newline="\n") as f:
            f.write(dump_config(cfg))
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(entries, indent=1, ensure_ascii=True) + "\n")


def generate(plaid_dir: str = PLAID_DIR, *, write: bool = True) -> dict:
    """Build (and write) <plaid_dir>/profiles/*.json from the vendored PNC data. generate.py calls this after plaid_user."""
    configs, entries, stats = build_all(plaid_dir)
    if write:
        write_all(configs, entries, os.path.join(plaid_dir, "profiles"))
    stats["profiles"], stats["entries"] = len(configs), entries
    return stats


def main(argv: list[str]) -> int:
    plaid_dir = PLAID_DIR
    if "--out" in argv:
        plaid_dir = os.path.abspath(argv[argv.index("--out") + 1])
    stats = generate(plaid_dir, write="--check" not in argv)
    entries = stats["entries"]
    if "--check" not in argv:
        print(f"wrote {stats['profiles']} profiles + index.json ({len(entries)} entries) to {os.path.relpath(os.path.join(plaid_dir, 'profiles'), os.getcwd())}")
    tx, by = stats["tx"], stats["bytes"]
    print(f"date shift +{stats['shift_days']} days (PNC 2026-10-31 -> {ANCHOR_END}); windows (months): "
          + ", ".join(f"{n}m x{sum(1 for v in stats['windows'].values() if v == n)}" for n in sorted(set(stats["windows"].values()), reverse=True)))
    print(f"transactions per profile: min {min(tx.values())}, max {max(tx.values())} (cap {MAX_TX}); override_password max {max(by.values()) / 1024:.1f} KB (cap {MAX_COMPACT_BYTES / 1024:.0f} KB)")
    if "--list" in argv:
        for e in entries:
            print(f"  {e['profile_id']:<12} {e['txn_count']:>4} tx  {e['display_name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
