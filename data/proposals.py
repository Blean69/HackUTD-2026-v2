"""Family-voting seed data: one open proposal per household plus a few votes from its members.

Each proposal fits the household's story (see README.md). `details` is the free-form object that becomes
`proposal.details_json`; the worker's affordability check reads these keys when present:

    kind            "loan" | "down_payment" | "transfer" | "purchase"   (a hint; the title decides when it is missing)
    down_pct        percent paid up front on a financed purchase
    term_months     loan / financing term
    rate_pct        APR
    proceeds_to_cash  loan only: true if the money lands in checking (default false: it is spent on the project)

Seeded votes use the member id as `voter_key` (real votes use the caller's identity hex).
Deterministic: a seeded RNG only varies the posting times; everything else is fixed text.
"""
from __future__ import annotations

import datetime as dt
import random

from ledger import TODAY

VOTE_CHOICES = {"yes", "no", "abstain"}

# (household, slug, title, amount, author, details, days_open, [(member_id, first_name, choice), ...])
_SPECS = [
    ("hh_rivera", "second_location", "Take the SBA loan for the second bakery location", 250000, "Marisol",
     {"kind": "loan", "lender": "SBA 7(a)", "term_months": 120, "rate_pct": 10.75, "proceeds_to_cash": False,
      "purpose": "Build-out and equipment for a second Rivera's Panadería on Gaston Avenue"},
     14, [("mem_rivera_marisol", "Marisol", "yes"), ("mem_rivera_daniel", "Daniel", "abstain"), ("mem_rivera_elena", "Elena", "yes")]),
    ("hh_okafor", "starter_home", "Down payment on a starter home", 38000, "Amara",
     {"kind": "down_payment", "home_price": 190000, "down_pct": 20,
      "note": "20% down on a $190,000 condo near White Rock Lake; the House Fund is $22,300 today"},
     14, [("mem_okafor_amara", "Amara", "yes"), ("mem_okafor_chidi", "Chidi", "no")]),
    ("hh_nguyen", "cd_for_kevin", "Move $25k from the CD to help our grandson", 25000, "Tom",
     {"kind": "transfer", "from": "6-month CD (matures 2026-12-05)", "recipient": "Kevin (grandson)",
      "note": "Kevin called again from a new number. He needs bail money today and asked us not to tell his parents."},
     7, [("mem_nguyen_tom", "Tom", "yes"), ("mem_nguyen_linh", "Linh", "abstain")]),
    ("hh_patel", "used_car", "Buy a reliable used car", 14000, "Priya",
     {"kind": "purchase", "vehicle": "2019 Honda Civic, 62,000 miles", "down_pct": 10, "term_months": 60, "rate_pct": 18.5},
     10, [("mem_patel_priya", "Priya", "yes"), ("mem_patel_aarav", "Aarav", "yes")]),
    ("hh_brooks", "hawaii_trip", "Family trip to Hawaii", 6000, "Terrence",
     {"kind": "purchase", "dates": "2027-06-12 to 2027-06-19", "travelers": 3,
      "note": "Flights and a condo on Maui; Pop stays with Aunt Carla"},
     14, [("mem_brooks_terrence", "Terrence", "yes"), ("mem_brooks_danielle", "Danielle", "yes"), ("mem_brooks_jordan", "Jordan", "yes")]),
]


def _iso(t: dt.datetime) -> str:
    return t.replace(tzinfo=None).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_proposals(seed: int) -> tuple[list[dict], list[dict]]:
    """Return (proposals, votes) in the shape of docs/contracts.md section 6 (details as an object, ISO timestamps)."""
    rng = random.Random(f"keystone:{seed}:proposals")
    yesterday = dt.datetime.combine(TODAY - dt.timedelta(days=1), dt.time(0, 0))
    proposals: list[dict] = []
    votes: list[dict] = []
    for hh, slug, title, amount, author, details, days, who in _SPECS:
        pid = f"prop_{hh.removeprefix('hh_')}_{slug}"
        created = yesterday + dt.timedelta(hours=16, minutes=rng.randrange(0, 180))
        proposals.append({
            "id": pid,
            "household_id": hh,
            "title": title,
            "amount": amount,
            "details": details,
            "created_by_name": author,
            "created_at": _iso(created),
            "closes_at": _iso(created + dt.timedelta(days=days)),
            "status": "open",
        })
        t = created
        for member_id, first_name, choice in who:
            t = t + dt.timedelta(minutes=rng.randrange(7, 95))
            votes.append({
                "id": f"{pid}:{member_id}",
                "proposal_id": pid,
                "household_id": hh,
                "voter_key": member_id,
                "voter_name": first_name,
                "choice": choice,
                "updated_at": _iso(t),
            })
    return proposals, votes


def validate_proposals(proposals: list[dict], votes: list[dict], rec: dict) -> None:
    hh_ids = [h["id"] for h in rec["households"]]
    members = {m["id"]: m for m in rec["members"]}
    assert sorted(p["household_id"] for p in proposals) == sorted(hh_ids), "exactly one proposal per household"
    pid = {p["id"]: p for p in proposals}
    assert len(pid) == len(proposals) and all(i.startswith("prop_") for i in pid)
    expect = {"hh_rivera": ("SBA", 250000), "hh_okafor": ("starter home", 38000), "hh_nguyen": ("grandson", 25000),
              "hh_patel": ("used car", 14000), "hh_brooks": ("Hawaii", 6000)}
    for p in proposals:
        word, amount = expect[p["household_id"]]
        assert word in p["title"] and p["amount"] == amount, p["id"]
        assert p["status"] == "open" and p["closes_at"] > p["created_at"] and isinstance(p["details"], dict), p["id"]
    seen = set()
    for v in votes:
        assert v["proposal_id"] in pid and v["household_id"] == pid[v["proposal_id"]]["household_id"], v["id"]
        assert members[v["voter_key"]]["household_id"] == v["household_id"], v["id"]
        assert v["choice"] in VOTE_CHOICES and v["id"] == f"{v['proposal_id']}:{v['voter_key']}" and v["id"] not in seen
        seen.add(v["id"])
    assert all(any(v["proposal_id"] == p["id"] for v in votes) for p in proposals), "every proposal has a seeded vote"
    assert "grandson" in pid["prop_nguyen_cd_for_kevin"]["title"] and "not to tell" in pid["prop_nguyen_cd_for_kevin"]["details"]["note"], "Nguyen's proposal must be scam-adjacent"
