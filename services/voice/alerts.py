"""The critical alert Brian raises on a callback (docs/contracts.md section 10).

Selection: the household's REAL signals first (the worker's GET /phone/alert_candidates: open critical or warn alerts, rule hits such as card
testing, a scam-pattern payment, a large overnight transfer to a new payee, duplicates, a forecast overdraft on a date, a credit-score alert).
Only when there are none (or the worker is unreachable, or every one was used a moment ago) a TEMPLATE is filled with plausible amounts,
merchants, card last-4s and dates from the household's accounts. Seven templates:

  card_other_city      an unusual card charge in another city
  new_payee_3am        a new payee added at 3 a.m. plus a large transfer
  overdraft_two_bills  checking dips below zero on a date when two bills collide
  credit_drop_inquiry  a credit score drop after a hard inquiry nobody made
  gift_card_pattern    a suspicious run of gift-card purchases
  double_charge        the same merchant charging the card twice in a day
  card_testing         a burst of tiny charges, the card-testing pattern

Everything Brian SAYS first is deterministic text built here (no model in the loop), so the callback works even when the LLM is down:
`statement` (one or two short sentences with plain numbers) + `action` (what he recommends) + a dashboard line only if the alert really
was written + a question. The model takes over for the caller's questions, with `system_notes()` in its prompt."""
from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import prompts

NUM_WORDS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve"}
KINDS = ("fraud", "scam", "obligation", "data_quality", "insight")  # what the worker's agent_create_alert accepts


@dataclass(frozen=True)
class CallbackAlert:
    key: str  # candidate id ("alert:...", "txn:...", "forecast:...") or "tpl:<template>": remembered so the next callback picks another
    source: str  # "real" | "template"
    origin: str  # for the trace: "open alert", "rule: card_testing", "forecast", "template: card_other_city"
    kind: str  # alert kind to write
    title: str  # dashboard title (one line)
    detail: str  # dashboard detail
    statement: str  # spoken: one or two short sentences
    action: str  # spoken: what Brian recommends
    facts: tuple[tuple[str, str], ...] = ()  # plain facts the model may use when asked
    related_ids: tuple[str, ...] = ()
    existing_alert_id: str = ""  # an open critical alert already on the dashboard: reused, not written again
    severity: str = "critical"

    def api_payload(self) -> dict[str, Any]:
        """The body of POST /phone/callback_alert's `alert`."""
        return {"kind": self.kind, "title": self.title, "detail": self.detail, "related_ids": list(self.related_ids), "existing_alert_id": self.existing_alert_id, "origin": self.origin}


def spoken_script(alert: CallbackAlert, *, posted: bool) -> str:
    """What Brian says after the opening line. The dashboard sentence is only there when the alert really is on the dashboard."""
    parts = [alert.statement, alert.action, prompts.CALLBACK_DASHBOARD if posted else "", prompts.CALLBACK_ASK]
    return " ".join(p.strip() for p in parts if p.strip())


def system_notes(alert: CallbackAlert, *, posted: bool = True) -> str:
    """Added to the model's prompt for a callback: what was already said and the only facts it may add to."""
    facts = "\n".join(f"- {k}: {v}" for k, v in alert.facts)
    return (
        f"You just rang the family back, and you have already said, out loud: \"{alert.statement} {alert.action}\" "
        f"{'The alert is on their dashboard now. ' if posted else ''}Do not say hello again and do not repeat it unless they ask. Stay on the line for their questions.\n"
        f"The alert: {alert.title}. {alert.detail}\n"
        f"{facts}\n"
        "Those are the only details you have about it. If they ask for more (which store, which account, what to do), answer from them, from your tools "
        "(accounts, bills, forecast) and from the notes below; if you do not have a detail, say you are not sure and point them to the alert on their dashboard. "
        "You cannot freeze a card, move money or call the bank for them; you can only recommend it, and never offer to do it. Never ask for a PIN, password, code or card number. When they are done, say a short goodbye."
    )


# ---- helpers ------------------------------------------------------------------------------------------------------------------
def usd(n: float) -> str:
    return "${:,}".format(int(round(abs(n))))


def _round_to(n: float, step: int) -> int:
    return int(round(n / step)) * step


DIGIT_WORDS = "zero one two three four five six seven eight nine".split()


def say_digits(digits: str) -> str:
    """"7994" -> "seven nine nine four": a card's last four are said digit by digit, never as seven thousand nine hundred ninety-four."""
    return " ".join(DIGIT_WORDS[int(c)] for c in str(digits) if c.isdigit())


def speakable(name: str, limit: int = 40) -> str:
    """A merchant name from the books, made sayable: "Zelle, T Bryant, new payee" -> "Zelle T Bryant"."""
    n = re.sub(r"[,;]?\s*\bnew payee\b", "", str(name or ""), flags=re.I)
    n = re.sub(r"\s*[,;]\s*", " ", n)
    n = re.sub(r"\s*[-\u2013\u2014(].*$", "", n) if re.search(r"\s[-\u2013\u2014(]", n) else n
    n = re.sub(r"[#*]+\s*\d*|\s+", " ", n).strip()
    return n[:limit].rsplit(" ", 1)[0] if len(n) > limit and " " in n[:limit] else n[:limit]


def human_date(d: date) -> str:
    return f"{d:%B} {d.day}"


def _iso(s: Any, fallback: date) -> date:
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return fallback


def _clean(s: Any, n: int = 300) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", str(s or ""))).strip()[:n]


def _first_sentence(s: str, limit: int = 140) -> str:
    first = re.split(r"(?<=[.!?])\s", _clean(s, 400), maxsplit=1)[0]
    return first if len(first) <= limit else first[:limit].rsplit(" ", 1)[0]


def _sentence(s: str) -> str:
    s = s.strip()
    return s if not s or s[-1] in ".!?" else s + "."


@dataclass
class Ctx:
    """The household as the templates see it (all optional: a worker that is down gives plausible generic values)."""

    today: date
    city: str = "Dallas"
    state: str = "TX"
    family: str = ""
    checking_name: str = "checking"
    checking_last4: str = ""
    checking_balance: int | None = None
    card_name: str = "card"
    card_last4: str = ""
    cards: list[tuple[str, str]] = field(default_factory=list)
    has_savings: bool = False
    bills: list[tuple[str, int]] = field(default_factory=list)  # (name, amount), biggest first
    due_days: dict[str, int] = field(default_factory=dict)  # bill name -> day of the month it is due (from the obligations)

    @classmethod
    def from_payload(cls, payload: dict | None, rng: random.Random, today: date | None = None) -> "Ctx":
        c = (payload or {}).get("context") if isinstance(payload, dict) else None
        c = c if isinstance(c, dict) else {}
        ctx = cls(today=_iso(c.get("as_of"), today or date.today()), city=_clean(c.get("city"), 40) or "Dallas", state=_clean(c.get("state"), 4) or "TX", family=_clean(c.get("family"), 60))
        for a in c.get("accounts") or []:
            if not isinstance(a, dict):
                continue
            kind, name, last4 = a.get("type"), _clean(a.get("nickname"), 40), re.sub(r"\D", "", str(a.get("last4") or ""))[:4]
            if kind == "checking" and ctx.checking_last4 == "":
                ctx.checking_name, ctx.checking_last4 = name or "checking", last4
                bal = a.get("balance")
                ctx.checking_balance = int(bal) if isinstance(bal, (int, float)) else None
            elif kind == "credit_card" and last4:
                ctx.cards.append((name or "card", last4))
            elif kind == "savings":
                ctx.has_savings = True
        if ctx.cards:
            ctx.card_name, ctx.card_last4 = ctx.cards[0]
        else:
            ctx.card_last4 = str(rng.randint(1000, 9999))
        for o in c.get("obligations") or []:
            if isinstance(o, dict) and isinstance(o.get("amount"), (int, float)) and o.get("name"):
                name = _clean(o["name"], 40)
                ctx.bills.append((name, int(o["amount"])))
                if isinstance(o.get("due_day"), (int, float)) and 1 <= int(o["due_day"]) <= 31:
                    ctx.due_days[name] = int(o["due_day"])
        ctx.bills.sort(key=lambda b: -b[1])
        return ctx

    def pick_card(self, rng: random.Random) -> tuple[str, str]:
        return rng.choice(self.cards) if self.cards else (self.card_name, self.card_last4)


def _facts(**kw: Any) -> tuple[tuple[str, str], ...]:
    return tuple((k.replace("_", " "), str(v)) for k, v in kw.items() if v not in (None, ""))


# ---- templates ----------------------------------------------------------------------------------------------------------------
FAR_CITIES = ["Miami, Florida", "Las Vegas, Nevada", "Phoenix, Arizona", "Atlanta, Georgia", "Denver, Colorado", "Chicago, Illinois", "Orlando, Florida", "Seattle, Washington"]
FAR_MERCHANTS = ["Best Buy", "Apple Store", "Sunglass Hut", "Nordstrom", "Foot Locker", "Marriott"]
PAYEES = ["Orion Trade Group", "Sunrise Ventures LLC", "Global Remit", "K. Delgado", "Apex Consulting LLC"]
LENDERS = ["Capital Ridge Auto Finance", "Summit Card Services", "QuickLoan Direct", "Redwood Lending"]
GIFT_STORES = ["CVS", "Walgreens", "Target", "Walmart"]
DOUBLE_MERCHANTS = ["Costco", "Home Depot", "Kroger", "Lowe's", "Amazon"]


def _t_card_other_city(ctx: Ctx, rng: random.Random) -> CallbackAlert:
    amt = _round_to(rng.uniform(180, 880), 10)
    merchant, card = rng.choice(FAR_MERCHANTS), ctx.pick_card(rng)
    city = rng.choice([c for c in FAR_CITIES if not c.startswith(ctx.city)])
    short = city.split(",")[0]
    return CallbackAlert(
        key="tpl:card_other_city", source="template", origin="template: card_other_city", kind="fraud",
        title=f"{usd(amt)} charge in {short} on your card ending {card[1]}",
        detail=f"A {usd(amt)} charge at {merchant} in {city} posted to {card[0]} ending {card[1]}, far from home in {ctx.city}. If this wasn't you, freeze the card and dispute the charge.",
        statement=f"There's a {usd(amt)} charge at {merchant} in {short} on your card ending {say_digits(card[1])}. That's a long way from home.",
        action="I'd freeze that card until you've checked it.",
        facts=_facts(merchant=merchant, amount=usd(amt), city=city, card=f"{card[0]} ending {card[1]}", home_city=ctx.city),
    )


def _t_new_payee_3am(ctx: Ctx, rng: random.Random) -> CallbackAlert:
    cap = int(ctx.checking_balance * 0.6) if ctx.checking_balance and ctx.checking_balance > 2500 else 4800
    amt = _round_to(rng.uniform(1500, max(1600, min(9000, cap))), 100)
    payee = rng.choice(PAYEES)
    return CallbackAlert(
        key="tpl:new_payee_3am", source="template", origin="template: new_payee_3am", kind="fraud",
        title=f"New payee added at 3 a.m., then {usd(amt)} sent",
        detail=f"At about 3 a.m. a new payee, {payee}, was added to {ctx.checking_name}, and {usd(amt)} was sent to them right away. If this wasn't you, call the bank to stop the transfer and change your online banking password.",
        statement=f"A new payee was added to your {ctx.checking_name} at three this morning, and {usd(amt)} went out to them.",
        action="I'd call the bank to stop that transfer and change your online banking password.",
        facts=_facts(payee=payee, amount=usd(amt), account=ctx.checking_name, time="about 3 a.m."),
    )


def next_due(today: date, day: int) -> date:
    """The next date a bill due on `day` of the month falls on (today counts), clamped to short months."""
    y, m = today.year, today.month
    if day < today.day:
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(day, last))


def _two_bills(ctx: Ctx, rng: random.Random) -> list[tuple[str, int, date]]:
    """Two of the household's biggest bills with their REAL next due dates: of the three biggest that have a due day, the pair that
    falls closest together (the bigger pair on a tie). Without due days (no household data) two plausible bills two days apart."""
    dated = [(n, a, next_due(ctx.today, ctx.due_days[n])) for n, a in ctx.bills if n in ctx.due_days][:3]
    if len(dated) >= 2:
        pairs = [(x, y) for i, x in enumerate(dated) for y in dated[i + 1:]]
        x, y = min(pairs, key=lambda p: (abs((p[0][2] - p[1][2]).days), -(p[0][1] + p[1][1])))
        return sorted([x, y], key=lambda b: (b[2], -b[1]))
    first = ctx.today + timedelta(days=rng.randint(4, 9))
    return [("the car payment", rng.choice([420, 480, 540]), first), ("the electric bill", rng.choice([160, 190, 230]), first + timedelta(days=2))]


def _t_overdraft_two_bills(ctx: Ctx, rng: random.Random) -> CallbackAlert:
    a, b = _two_bills(ctx, rng)
    when = max(a[2], b[2])  # after both have gone out
    gap = abs((b[2] - a[2]).days)
    short = _round_to(rng.uniform(120, 640), 10)
    name_a, name_b = speakable(a[0].split(",")[0]), speakable(b[0].split(",")[0])
    if gap == 0:
        why = f"because two bills, {name_a} and {name_b}, land the same day."
        dates = f"{a[0]} ({usd(a[1])}) and {b[0]} ({usd(b[1])}) are both due on {human_date(when)}"
    else:
        days = NUM_WORDS.get(gap, str(gap)) + (" day" if gap == 1 else " days")
        why = f"because two big bills land {days} apart: {name_a} on {human_date(a[2])} and {name_b} on {human_date(b[2])}."
        dates = f"{a[0]} ({usd(a[1])}) is due on {human_date(a[2])} and {b[0]} ({usd(b[1])}) on {human_date(b[2])}, {days} apart"
    return CallbackAlert(
        key="tpl:overdraft_two_bills", source="template", origin="template: overdraft_two_bills", kind="obligation",
        title=f"{ctx.checking_name.capitalize()} could go below zero on {human_date(when)}",
        detail=f"{dates}, which would leave {ctx.checking_name} about {usd(short)} below zero. Make sure checking can cover both payments before then.",
        statement=f"Your {ctx.checking_name} is on track to go below zero on {human_date(when)}, about {usd(short)} short, {why}",
        action="I'd make sure checking can cover both payments before then.",
        facts=_facts(date=human_date(when), shortfall=usd(short), first_bill=f"{a[0]} {usd(a[1])}, due {human_date(a[2])}", second_bill=f"{b[0]} {usd(b[1])}, due {human_date(b[2])}"),
    )


def _t_credit_drop_inquiry(ctx: Ctx, rng: random.Random) -> CallbackAlert:
    pts, lender = rng.randint(22, 61), rng.choice(LENDERS)
    return CallbackAlert(
        key="tpl:credit_drop_inquiry", source="template", origin="template: credit_drop_inquiry", kind="credit",
        title=f"Credit score dropped {pts} points after a hard inquiry",
        detail=f"A hard inquiry from {lender} appeared on a credit file today and the simulated score fell {pts} points. If nobody in the family applied for credit, treat it as possible identity theft and freeze credit with the three bureaus.",
        statement=f"Your credit score just dropped {pts} points after a hard inquiry from {lender}. I don't see anyone in the family applying for anything.",
        action="I'd freeze your credit with the three bureaus until you've checked it.",
        facts=_facts(points_dropped=pts, lender=lender, note="the score on this demo is simulated"),
    )


def _t_gift_card_pattern(ctx: Ctx, rng: random.Random) -> CallbackAlert:
    n = rng.choice([3, 4])
    total = _round_to(n * rng.uniform(180, 480), 50)
    a, b = rng.sample(GIFT_STORES, 2)
    return CallbackAlert(
        key="tpl:gift_card_pattern", source="template", origin="template: gift_card_pattern", kind="scam",
        title=f"{NUM_WORDS[n].capitalize()} gift card purchases, {usd(total)} in two days",
        detail=f"{NUM_WORDS[n].capitalize()} gift card purchases totalling {usd(total)} in two days at {a} and {b}. Several large gift-card buys in a row is the classic scam payment pattern.",
        statement=f"There have been {NUM_WORDS[n]} gift card purchases, {usd(total)} together, in two days at {a} and {b}. That's a classic scam pattern.",
        action="If someone asked you to buy them, please stop, and don't read out the card numbers.",
        facts=_facts(purchases=n, total=usd(total), stores=f"{a} and {b}", window="two days"),
    )


def _t_double_charge(ctx: Ctx, rng: random.Random) -> CallbackAlert:
    amt, merchant, card = _round_to(rng.uniform(90, 600), 5), rng.choice(DOUBLE_MERCHANTS), ctx.pick_card(rng)
    return CallbackAlert(
        key="tpl:double_charge", source="template", origin="template: double_charge", kind="data_quality",
        title=f"{merchant} charged {usd(amt)} twice",
        detail=f"{merchant} charged {card[0]} ending {card[1]} {usd(amt)} twice within a day. One of them is probably a duplicate.",
        statement=f"{merchant} charged your card ending {say_digits(card[1])} {usd(amt)} twice within a day.",
        action="I'd dispute the second one with the card company.",
        facts=_facts(merchant=merchant, amount=usd(amt), card=f"{card[0]} ending {card[1]}"),
    )


def _t_card_testing(ctx: Ctx, rng: random.Random) -> CallbackAlert:
    n, card = rng.randint(6, 11), ctx.pick_card(rng)
    return CallbackAlert(
        key="tpl:card_testing", source="template", origin="template: card_testing", kind="fraud",
        title=f"{n} tiny charges on your card ending {card[1]}",
        detail=f"{n} charges under $2 hit {card[0]} ending {card[1]} within ten minutes. A burst of tiny charges is how thieves test a stolen card before a big purchase.",
        statement=f"Your card ending {say_digits(card[1])} had {NUM_WORDS[n]} tiny charges, under two dollars each, in ten minutes. That's what card testing looks like.",
        action="I'd freeze the card and ask for a new one.",
        facts=_facts(charges=n, each="under two dollars", window="ten minutes", card=f"{card[0]} ending {card[1]}"),
    )


TEMPLATES = {
    "card_other_city": _t_card_other_city,
    "new_payee_3am": _t_new_payee_3am,
    "overdraft_two_bills": _t_overdraft_two_bills,
    "credit_drop_inquiry": _t_credit_drop_inquiry,
    "gift_card_pattern": _t_gift_card_pattern,
    "double_charge": _t_double_charge,
    "card_testing": _t_card_testing,
}


def template_alert(ctx: Ctx, rng: random.Random, exclude: frozenset[str] | set[str] = frozenset(), name: str | None = None) -> CallbackAlert:
    """A filled template. Keeps clear of the ones used a moment ago (`exclude` holds "tpl:<name>" keys) unless all of them were."""
    if name is None:
        fresh = [n for n in TEMPLATES if f"tpl:{n}" not in exclude] or list(TEMPLATES)
        name = rng.choice(fresh)
    return TEMPLATES[name](ctx, rng)


# ---- real signals -------------------------------------------------------------------------------------------------------------
def _ending(f: dict) -> str:
    return f" ending {say_digits(f['last4'])}" if f.get("last4") else ""


def _render_real(c: dict, ctx: Ctx) -> CallbackAlert | None:
    f = c.get("facts") if isinstance(c.get("facts"), dict) else {}
    typ, title, detail = c.get("type"), _clean(c.get("title"), 200), _clean(c.get("detail"), 900)
    when = human_date(_iso(f.get("date"), ctx.today)) if f.get("date") else ""
    on = f" on {when}" if when else ""
    kind = c.get("kind") if c.get("kind") in KINDS else "fraud"
    related = tuple(_clean(r, 80) for r in (c.get("related_ids") or []) if r)[:6]
    existing = _clean(c.get("alert_id"), 120) if c.get("alert_id") and c.get("severity") == "critical" and typ in ("open_alert", "credit_drop") else ""
    base = dict(key=_clean(c.get("id"), 120), source="real", kind=kind, title=title or "Critical alert", detail=detail or title, related_ids=related, existing_alert_id=existing)
    amount = f.get("amount") if isinstance(f.get("amount"), (int, float)) else None
    if typ == "card_testing":
        n = int(f.get("count") or 0)
        count = NUM_WORDS.get(n, str(n)) if n else "several"
        return CallbackAlert(**base, origin="rule: card_testing", statement=f"There were {count} tiny charges, under two dollars each, on your {f.get('account', 'card')}{_ending(f)}{on}. That's what card testing looks like.", action="I'd freeze the card and ask for a new one.", facts=_facts(charges=n, date=when, card=f"{f.get('account', '')}{_ending(f)}"))
    if typ == "scam_payment" and amount:
        merchant = speakable(f.get("merchant")) or "a store"
        what = f"gift card purchase at {merchant}" if f.get("category") == "gift_cards" else f"payment to {merchant}"
        return CallbackAlert(**base, origin="rule: scam_payment", statement=f"A {usd(amount)} {what}{on} looks like a scam payment. Gift card and wire payments of that size are the classic trick.", action="If someone asked you to pay that way, please stop. I'd call your bank about getting it back.", facts=_facts(amount=usd(amount), merchant=merchant, date=when, account=f.get("account")))
    if typ == "new_payee_transfer" and amount:
        merchant = speakable(f.get("merchant")) or "someone"
        night = " in the middle of the night" if f.get("overnight") else ""
        return CallbackAlert(**base, origin="rule: new_payee_transfer", statement=f"A large payment of {usd(amount)} went out to {merchant}{on}{night}, and it looks like a new payee.", action="I'd call the bank to make sure that was you.", facts=_facts(amount=usd(amount), payee=merchant, date=when, account=f.get("account")))
    if typ == "duplicate" and amount:
        merchant = speakable(f.get("merchant")) or "a store"
        return CallbackAlert(**base, origin="rule: duplicate", statement=f"{merchant} charged you {usd(amount)} twice within a day.", action="I'd dispute the second one.", facts=_facts(amount=usd(amount), merchant=merchant, date=when))
    if typ == "overdraft":
        short = int(f.get("shortfall") or 0)
        bills = int(f.get("bills_due") or 0)
        statement = f"Your checking looks set to go below zero on {when}" + (f", about {usd(short)} short" if short else "") + "."
        if bills:
            statement += f" Bills due that day add up to {usd(bills)}."
        return CallbackAlert(**base, origin="forecast: overdraft", statement=statement, action="I'd make sure checking can cover the payments due then.", facts=_facts(date=when, shortfall=usd(short) if short else "", bills_due=usd(bills) if bills else "", bills_that_day=f.get("bills_that_day")))
    if typ in ("credit_drop", "open_alert") and title:
        origin = "open alert: credit score" if typ == "credit_drop" else f"open {c.get('severity', '')} alert"
        extra = _first_sentence(detail) if detail and _first_sentence(detail).lower() != title.lower() else ""
        return CallbackAlert(**base, origin=origin, statement=_sentence(f"{title}") + (f" {_sentence(extra)}" if extra and len(title) + len(extra) < 220 else ""), action="The details and the reason are on your dashboard." if existing else "I'd take a look at it today.", facts=_facts(alert=title, details=detail, **{"alert kind": f.get("alert_kind")}))
    return None


def select_alert(payload: dict | None, *, rng: random.Random | None = None, exclude: frozenset[str] | set[str] = frozenset(), today: date | None = None) -> CallbackAlert:
    """Real signals first (highest priority that was not used a moment ago), otherwise a template. Never raises: a missing or broken payload
    just means a template. `exclude` = keys used recently (candidate ids and "tpl:<name>")."""
    rng = rng or random.Random()
    ctx = Ctx.from_payload(payload, rng, today)
    cands = (payload or {}).get("candidates") if isinstance(payload, dict) else None
    ranked = sorted((c for c in (cands or []) if isinstance(c, dict) and c.get("id")), key=lambda c: -(c.get("priority") if isinstance(c.get("priority"), (int, float)) else 0))
    for c in ranked:
        if c["id"] in exclude:
            continue
        try:
            alert = _render_real(c, ctx)
        except Exception:  # a malformed candidate must not cost the callback
            alert = None
        if alert:
            return alert
    return template_alert(ctx, rng, exclude)
