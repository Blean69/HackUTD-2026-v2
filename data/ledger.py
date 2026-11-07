"""Ledger engine for the synthetic household data.

Everything here is deterministic given the `random.Random` instance passed in.
Pure standard library.

Conventions (also documented in data/README.md):
  * Deposit accounts (checking/savings/cd/ira): balance is money the household HAS.
  * Debt accounts (credit_card/auto_loan/personal_loan/mortgage): balance is the
    positive amount OWED.
  * Transaction.amount: negative = money leaves that account / a charge is made;
    on a debt account a positive amount is a payment received.
  * Rows labelled `duplicate` or `impossible_value` are import artefacts: they
    are NOT part of the true balance (balance == opening + sum of all other rows).
"""
from __future__ import annotations

import calendar
import datetime as dt
import math
from typing import Callable, Iterable

TODAY = dt.date(2026, 11, 7)
WIN_START = dt.date(2026, 5, 9)
WIN_END = dt.date(2026, 11, 6)
EXCLUDED = {"duplicate", "impossible_value"}
DEBT_TYPES = {"credit_card", "auto_loan", "personal_loan", "mortgage"}

ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"


def clip_day(y: int, m: int, d: int) -> dt.date:
    return dt.date(y, m, min(d, calendar.monthrange(y, m)[1]))


def window_months() -> list[tuple[int, int]]:
    out, y, m = [], WIN_START.year, WIN_START.month
    while (y, m) <= (WIN_END.year, WIN_END.month):
        out.append((y, m))
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def monthly_dates(day: int) -> list[dt.date]:
    return [d for y, m in window_months() if WIN_START <= (d := clip_day(y, m, day)) <= WIN_END]


def month_end_dates() -> list[dt.date]:
    out = []
    for y, m in window_months():
        d = clip_day(y, m, 31)
        if WIN_START <= d <= WIN_END:
            out.append(d)
    return out


def every(anchor: dt.date, step: int = 14) -> list[dt.date]:
    """Dates anchor + k*step (k any integer) that fall inside the window."""
    d = anchor
    while d - dt.timedelta(days=step) >= WIN_START:
        d -= dt.timedelta(days=step)
    while d < WIN_START:
        d += dt.timedelta(days=step)
    out = []
    while d <= WIN_END:
        out.append(d)
        d += dt.timedelta(days=step)
    return out


def weekday_dates(weekday: int) -> list[dt.date]:
    return [WIN_START + dt.timedelta(days=i) for i in range((WIN_END - WIN_START).days + 1)
            if (WIN_START + dt.timedelta(days=i)).weekday() == weekday]


def nth_weekday(y: int, m: int, weekday: int, n: int) -> dt.date:
    first = dt.date(y, m, 1)
    delta = (weekday - first.weekday()) % 7
    return first + dt.timedelta(days=delta + 7 * (n - 1))


# --------------------------------------------------------------------------- merchants
# key -> (display name, raw bank descriptor template)
M = {
    # groceries / big box
    "kroger": ("Kroger", "KROGER #{n} {city} TX"),
    "heb": ("H-E-B", "H-E-B #{n} {city} TX"),
    "tomthumb": ("Tom Thumb", "TOM THUMB #{n} {city} TX"),
    "fiesta": ("Fiesta Mart", "FIESTA MART #{n} {city} TX"),
    "walmart": ("Walmart", "WAL-MART SUPERCENTER #{n} {city} TX"),
    "aldi": ("Aldi", "ALDI {n} {city} TX"),
    "costco": ("Costco", "COSTCO WHSE #{n} {city} TX"),
    "sprouts": ("Sprouts Farmers Market", "SPROUTS FARMERS MKT #{n} {city} TX"),
    "hmart": ("H Mart", "H MART {city} TX"),
    "ranch99": ("99 Ranch Market", "99 RANCH MARKET #{n} {city} TX"),
    "savealot": ("Save A Lot", "SAVE A LOT #{n} {city} TX"),
    "samsclub": ("Sam's Club", "SAMS CLUB #{n} {city} TX"),
    "target": ("Target", "TARGET T-{n} {city} TX"),
    # dining
    "chickfila": ("Chick-fil-A", "CHICK-FIL-A #0{n} {city} TX"),
    "whataburger": ("Whataburger", "WHATABURGER #{n} {city} TX"),
    "torchys": ("Torchy's Tacos", "TORCHYS TACOS {city} TX"),
    "mcdonalds": ("McDonald's", "MCDONALD'S F{n} {city} TX"),
    "chipotle": ("Chipotle", "CHIPOTLE {n} {city} TX"),
    "starbucks": ("Starbucks", "STARBUCKS STORE {n} {city} TX"),
    "panda": ("Panda Express", "PANDA EXPRESS #{n} {city} TX"),
    "jerseymikes": ("Jersey Mike's", "JERSEY MIKES {n} {city} TX"),
    "pho": ("Pho Saigon", "PHO SAIGON RESTAURANT {city} TX"),
    "elfenix": ("El Fenix", "EL FENIX {city} TX"),
    "primos": ("Taqueria Los Primos", "TST* TAQUERIA LOS PRIMOS {city}"),
    "dutchbros": ("Dutch Bros", "DUTCH BROS #{n} {city} TX"),
    "canes": ("Raising Cane's", "RAISING CANES #{n} {city} TX"),
    "sonic": ("Sonic Drive-In", "SONIC DRIVE IN #{n} {city} TX"),
    "pizzapatron": ("Pizza Patron", "PIZZA PATRON {n} {city} TX"),
    "banhmi": ("Banh Mi Che Cali", "BANH MI CHE CALI {city} TX"),
    "dairyqueen": ("Dairy Queen", "DAIRY QUEEN #{n} {city} TX"),
    "doordash": ("DoorDash", "DD *DOORDASH {r}"),
    # fuel
    "qt": ("QuikTrip", "QT {n} {city} TX"),
    "shell": ("Shell", "SHELL OIL {n}{city} TX"),
    "exxon": ("ExxonMobil", "EXXONMOBIL {n} {city} TX"),
    "racetrac": ("RaceTrac", "RACETRAC {n} {city} TX"),
    "bucees": ("Buc-ee's", "BUC-EE'S #{n} {city} TX"),
    "chevron": ("Chevron", "CHEVRON {n} {city} TX"),
    # shopping
    "amazon": ("Amazon", "AMZN Mktp US*{r}"),
    "homedepot": ("The Home Depot", "THE HOME DEPOT #{n} {city} TX"),
    "lowes": ("Lowe's", "LOWES #{n} {city} TX"),
    "hobbylobby": ("Hobby Lobby", "HOBBY LOBBY #{n} {city} TX"),
    "ross": ("Ross Stores", "ROSS STORES #{n} {city} TX"),
    "tjmaxx": ("T.J. Maxx", "TJ MAXX #{n} {city} TX"),
    "dollartree": ("Dollar Tree", "DOLLAR TREE #{n} {city} TX"),
    "bestbuy": ("Best Buy", "BEST BUY #{n} {city} TX"),
    "kohls": ("Kohl's", "KOHLS #{n} {city} TX"),
    "oldnavy": ("Old Navy", "OLD NAVY #{n} {city} TX"),
    "dicks": ("Dick's Sporting Goods", "DICKS SPORTING GOODS #{n} {city} TX"),
    "fivebelow": ("Five Below", "FIVE BELOW #{n} {city} TX"),
    "bnnoble": ("Barnes & Noble", "BARNES & NOBLE #{n} {city} TX"),
    "walmartshop": ("Walmart", "WM SUPERCENTER #{n} {city} TX"),
    # health
    "cvs": ("CVS Pharmacy", "CVS/PHARMACY #{n} {city} TX"),
    "walgreens": ("Walgreens", "WALGREENS #{n} {city} TX"),
    # entertainment
    "amc": ("AMC Theatres", "AMC {n} {city} TX"),
    "zoo": ("Dallas Zoo", "DALLAS ZOO MGMT INC DALLAS TX"),
    "sixflags": ("Six Flags Over Texas", "SIX FLAGS OVER TEXAS ARLINGTON TX"),
    "topgolf": ("Topgolf", "TOPGOLF {city} TX"),
    "mainevent": ("Main Event", "MAIN EVENT {city} TX"),
    # transport
    "uber": ("Uber", "UBER *TRIP {r}"),
    "ntta": ("NTTA", "NTTA EZ TAG REBILL"),
    "dart": ("DART", "DART FARE ZONE {n}"),
}


class Book:
    """Collects accounts, transactions and obligations for all households."""

    def __init__(self, rng):
        self.rng = rng
        self.rows: list[dict] = []
        self.accts: dict[str, dict] = {}
        self.obl: list[dict] = []
        self._seq = 0
        self._stores: dict[tuple, int] = {}

    # ---- structure
    def acct(self, aid, hh, owners, typ, inst, nick, target, opened, **kw):
        a = dict(id=aid, household_id=hh, owner_member_ids=list(owners), type=typ, institution=inst,
                 nickname=nick, balance=round(target, 2))
        for k in ("rate_pct", "credit_limit", "monthly_payment", "maturity_date"):
            if kw.get(k) is not None:
                a[k] = kw[k]
        a["opened_date"] = opened
        a["_target"] = target
        self.accts[aid] = a
        return a

    def hh_of(self, aid):
        return self.accts[aid]["household_id"]

    def obligation(self, aid_paid_from, name, amount, due_day, kind):
        hh = self.hh_of(aid_paid_from)
        n = sum(1 for o in self.obl if o["household_id"] == hh) + 1
        self.obl.append(dict(id=f"obl_{hh[3:]}_{n:02d}", household_id=hh, name=name, amount=round(amount, 2),
                             due_day=int(due_day), account_id=aid_paid_from, kind=kind))

    # ---- transactions
    def tx(self, aid, d, amount, merchant, category, desc, rec=False, anomaly=None, tag=None):
        self._seq += 1
        self.rows.append(dict(seq=self._seq, account_id=aid, date=d, amount=round(amount, 2), merchant=merchant,
                              category=category, description=desc, is_recurring=rec, anomaly=anomaly, tag=tag))
        return self.rows[-1]

    def rows_for(self, aid, upto=None, after=None, true_only=True):
        for r in self.rows:
            if r["account_id"] != aid:
                continue
            if true_only and r["anomaly"] in EXCLUDED:
                continue
            if upto is not None and r["date"] > upto:
                continue
            if after is not None and r["date"] <= after:
                continue
            yield r

    def total(self, aid, upto=None, after=None):
        return round(sum(r["amount"] for r in self.rows_for(aid, upto, after)), 2)

    # ---- descriptor helpers
    def store_no(self, hh, key):
        k = (hh, key)
        if k not in self._stores:
            self._stores[k] = self.rng.choice([self.rng.randint(100, 9999) for _ in range(3)])
        return self._stores[k]

    def merchant(self, hh, key, city, varied=False):
        name, tpl = M[key]
        n = self.store_no(hh, key)
        if varied and self.rng.random() < 0.3:
            n = self.rng.randint(100, 9999)
        r = "".join(self.rng.choice(ALNUM) for _ in range(9))
        return name, tpl.format(n=n, city=city.upper(), r=r)

    def descr(self, aid, d, raw):
        if self.accts[aid]["type"] == "checking":
            return f"PURCHASE AUTHORIZED ON {d:%m/%d} {raw}"
        return f"{raw}"


# --------------------------------------------------------------------------- generators
def weighted(rng, pairs):
    total = sum(w for _, w in pairs)
    x = rng.random() * total
    for k, w in pairs:
        x -= w
        if x <= 0:
            return k
    return pairs[-1][0]


def lognorm(rng, median, sigma, lo, hi):
    return round(min(hi, max(lo, rng.lognormvariate(math.log(median), sigma))), 2)


def sprinkle(b: Book, hh: str, city: str, cat: str, items, pw: float, med: float, sig: float, lo: float, hi: float,
             accts, dow=None, varied=True, start=None, end=None, day_mult: Callable | None = None):
    """Random discretionary spend. items=[(merchant_key, weight)], accts=[(acct_id, weight)]."""
    rng = b.rng
    d = start or WIN_START
    end = end or WIN_END
    while d <= end:
        w = (dow or {}).get(d.weekday(), 1.0) * (day_mult(d) if day_mult else 1.0)
        p = pw / 7.0 * w
        k = 0
        while rng.random() < p and k < 3:
            k += 1
            p *= 0.3
            key = weighted(rng, items)
            aid = weighted(rng, accts)
            name, raw = b.merchant(hh, key, city, varied)
            amt = lognorm(rng, med, sig, lo, hi)
            b.tx(aid, d, -amt, name, cat, b.descr(aid, d, raw))
        d += dt.timedelta(days=1)


def monthly(b: Book, aid: str, day: int, amount: float, merchant: str, desc: str, cat: str, rec=True,
            jitter=0.0, season: dict | None = None, ob: tuple | None = None, start=None):
    """A bill / paycheck-like item on a given day of month. Positive amount = inflow."""
    rng = b.rng
    for d in monthly_dates(day):
        if start and d < start:
            continue
        a = amount * (season.get(d.month, 1.0) if season else 1.0)
        if jitter:
            a *= 1 + rng.uniform(-jitter, jitter)
        b.tx(aid, d, round(a, 2), merchant, cat, desc.format(d=d, m=d.month), rec)
    if ob:
        b.obligation(aid, ob[0], abs(amount), day, ob[1])


def loan_payment(b: Book, loan: str, chk: str, day: int, amount: float, payee: str, desc: str, cat: str,
                 ob_name: str | None = None):
    """Checking pays a loan: negative on checking, positive (payment received) on the loan account."""
    for d in monthly_dates(day):
        b.tx(chk, d, -amount, payee, cat, desc.format(d=d), True)
        b.tx(loan, d, amount, payee, cat, "PAYMENT RECEIVED - THANK YOU", True)
    b.obligation(chk, ob_name or f"{payee} payment", amount, day, "loan")


def transfer_monthly(b: Book, src: str, dst: str, day: int, amount: float, desc_out: str, desc_in: str,
                     cat="transfer", ob=None):
    for d in monthly_dates(day):
        b.tx(src, d, -amount, "Transfer", cat, desc_out, True)
        b.tx(dst, d, amount, "Transfer", cat, desc_in, True)
    if ob:
        b.obligation(src, ob[0], amount, day, ob[1])


def card_payments(b: Book, card: str, chk: str, day: int, payee: str, mode: str = "full",
                  owed0: float = 0.0, target_final: float | None = None, min_pay: float = 35.0,
                  ob_name: str | None = None):
    """Pay a credit card from checking once a month.

    mode 'full'    : pay everything charged since the previous payment.
    mode 'revolve' : leave a balance, steering the final owed amount to ~target_final.
    """
    pay_dates = monthly_dates(day)
    prev = WIN_START - dt.timedelta(days=1)
    cycles = []
    for pd_ in pay_dates:
        ch = -sum(r["amount"] for r in b.rows_for(card, upto=pd_, after=prev) if r["amount"] < 0)
        cycles.append((pd_, round(ch, 2)))
        prev = pd_
    last_leftover = -sum(r["amount"] for r in b.rows_for(card, after=pay_dates[-1]) if r["amount"] < 0)
    n = len(pay_dates)
    drift = 0.0
    if mode == "revolve":
        drift = (target_final - last_leftover - owed0) / n
    pays = []
    for pd_, ch in cycles:
        amt = ch if mode == "full" else max(min_pay, ch - drift)
        amt = round(amt, 2)
        if amt <= 0:
            continue
        b.tx(chk, pd_, -amt, payee, "credit_card_payment", f"ONLINE PAYMENT TO {payee.upper()} {pd_:%m/%d}", True)
        b.tx(card, pd_, amt, payee, "credit_card_payment", "PAYMENT THANK YOU", True)
        pays.append(amt)
    b.accts[card]["_owed0"] = owed0
    avg = sum(pays) / max(1, len(pays))
    b.obligation(chk, ob_name or f"{payee} payment", round(avg, 0), day, "loan")


def interest_credits(b: Book, aid: str, apy: float, est_balance: float, day: int | None = None):
    rng = b.rng
    dates = month_end_dates() if day is None else monthly_dates(day)
    for d in dates:
        amt = round(est_balance * apy / 100 / 12 * rng.uniform(0.97, 1.03), 2)
        b.tx(aid, d, amt, "Interest Payment", "interest", "INTEREST PAYMENT", True)


def _future_low(b: Book, aid: str, d, until):
    """Lowest cumulative net flow (<= 0) on `aid` over the days after d up to and including `until`."""
    bal = lo = 0.0
    for r in sorted(b.rows_for(aid, upto=until, after=d), key=lambda r: (r["date"], r["seq"])):
        bal += r["amount"]
        lo = min(lo, bal)
    return lo


def sweeps(b: Book, chk: str, sav: str, s0: float, cushion: float, final_target: float, day=27, frac=0.7,
           step=25, floor=1500.0, label_out="ONLINE TRANSFER TO SAVINGS", label_in="ONLINE TRANSFER FROM CHECKING"):
    """Move surplus checking cash to savings (or pull from savings when thin) once a month, looking ahead so
    checking never dips below `floor`. The last sweep lands checking exactly on final_target after the remaining flows."""
    dates = [d for y, m in window_months() if WIN_START <= (d := clip_day(y, m, day)) <= WIN_END]
    for i, d in enumerate(dates):
        bal = s0 + b.total(chk, upto=d)
        last = i == len(dates) - 1
        until = WIN_END if last else dates[i + 1]
        lo = _future_low(b, chk, d, until)
        if last:
            amt = bal - (final_target - b.total(chk, after=d))
        else:
            amt = (bal - cushion) * (frac if bal > cushion else 0.6)
            amt = min(amt, bal + lo - floor)
            if bal + lo < floor:
                amt = bal + lo - floor  # negative: pull from savings
        amt = round(amt / step) * step
        if abs(amt) < step:
            continue
        if amt > 0:
            b.tx(chk, d, -amt, "Transfer", "transfer", f"{label_out} {sav[-4:].upper()}", False, tag="sweep")
            b.tx(sav, d, amt, "Transfer", "transfer", label_in, False, tag="sweep")
        else:
            b.tx(chk, d, -amt, "Transfer", "transfer", "ONLINE TRANSFER FROM SAVINGS", False, tag="sweep")
            b.tx(sav, d, amt, "Transfer", "transfer", "ONLINE TRANSFER TO CHECKING", False, tag="sweep")


def overdraft_fees(b: Book, chk: str, s0: float, fee=35.0):
    rows = sorted((r for r in b.rows_for(chk)), key=lambda r: (r["date"], r["seq"]))
    bal, fee_days = s0, set()
    for r in rows:
        bal += r["amount"]
        if bal < 0 and r["amount"] < 0 and r["date"] not in fee_days and r["category"] != "fees":
            fee_days.add(r["date"])
            b.tx(chk, r["date"], -fee, "Overdraft Fee", "fees", "OVERDRAFT FEE - ITEM PAID", False, tag="fee")
            bal -= fee
    return len(fee_days)


def running_min(b: Book, aid: str, s0: float):
    rows = sorted(b.rows_for(aid), key=lambda r: (r["date"], r["seq"]))
    bal, lo = s0, s0
    for r in rows:
        bal += r["amount"]
        lo = min(lo, bal)
    return round(lo, 2)


# --------------------------------------------------------------------------- anomaly helpers
SYMS = "#@$%&*~^¤¶§¿�†‡¦"


def garble_text(rng, s: str, mode: str | None = None) -> str:
    mode = mode or rng.choice(["moji", "symbols", "symbols"])
    if mode == "moji":
        subs = {"a": "á", "e": "é", "o": "ó", "u": "ú", "n": "ñ", "E": "É", "O": "Ó"}
        out, hits = [], 0
        for ch in s:
            if ch in subs and hits < 3 and rng.random() < 0.5:
                out.append(subs[ch])
                hits += 1
            else:
                out.append(ch)
        t = "".join(out)
        if hits == 0:
            t = t + " é"
        return t.encode("utf-8").decode("cp1252", errors="replace")
    chars = list(s)
    idx = [i for i, c in enumerate(chars) if c.isalnum()]
    for i in rng.sample(idx, min(len(idx), max(2, len(idx) // 4))):
        chars[i] = rng.choice(SYMS)
    return "".join(chars)


def mark_duplicates(b: Book, aid: str, n: int, min_amt=8.0, max_amt=400.0, next_day_prob=0.35):
    rng = b.rng
    cands = [r for r in b.rows_for(aid) if -max_amt <= r["amount"] <= -min_amt and not r["is_recurring"]
             and r["anomaly"] is None and r["category"] in ("groceries", "dining", "shopping", "fuel", "health")]
    for r in rng.sample(cands, min(n, len(cands))):
        d = r["date"] + (dt.timedelta(days=1) if rng.random() < next_day_prob and r["date"] < WIN_END else dt.timedelta())
        b.tx(aid, d, r["amount"], r["merchant"], r["category"], r["description"], False, anomaly="duplicate")


def mark_garbled(b: Book, aid: str, n: int, modes=None):
    rng = b.rng
    dups = {(r["account_id"], r["amount"], r["merchant"]) for r in b.rows if r["anomaly"] == "duplicate"}
    cands = [r for r in b.rows_for(aid) if r["amount"] < 0 and not r["is_recurring"] and r["anomaly"] is None
             and r["category"] in ("groceries", "dining", "shopping", "fuel", "health", "entertainment")
             and (r["account_id"], r["amount"], r["merchant"]) not in dups]
    for i, r in enumerate(rng.sample(cands, min(n, len(cands)))):
        mode = (modes[i % len(modes)] if modes else None)
        r["merchant"] = garble_text(rng, r["merchant"], mode)
        r["description"] = garble_text(rng, r["description"], mode)
        r["anomaly"] = "garbled"
