#!/usr/bin/env python3
"""Keystone synthetic data generator (household side).

    python3 generate.py [--seed 2026] [--out seed] [--report]

Deterministic: same seed -> byte-identical files. Pure standard library, Python 3.12+.
Writes households, members, accounts, transactions, credit_profiles, obligations, conversations, proposals and
votes (.json) into data/seed/ (see ../docs/contracts.md sections 1 and 6, and data/README.md), plus the Plaid
Sandbox custom user (the demo bank for onboarding, contracts.md section 7) into ../plaid/sandbox_user.json.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from convos import build_conversations  # noqa: E402
from households import build_all, to_records  # noqa: E402
from ledger import TODAY, WIN_END  # noqa: E402
from plaid_user import build_sandbox_user, dump_config as dump_plaid_user  # noqa: E402
from proposals import build_proposals, validate_proposals  # noqa: E402

FILES = ["households", "members", "accounts", "transactions", "credit_profiles", "obligations", "conversations",
         "proposals", "votes"]
ALL_TYPES = {"checking", "savings", "cd", "ira", "auto_loan", "personal_loan", "credit_card", "mortgage"}
LABELS = {"duplicate", "garbled", "impossible_value", "card_testing", "account_takeover", "scam_payment", "outlier"}


def dump_list(path: str, rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write("[\n" + ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows) + "\n]\n")


def net_worth(rec: dict, hh: str) -> float:
    h = next(x for x in rec["households"] if x["id"] == hh)
    assets = sum(a["balance"] for a in rec["accounts"] if a["household_id"] == hh and a["type"] in ("checking", "savings", "cd", "ira"))
    debts = sum(a["balance"] for a in rec["accounts"] if a["household_id"] == hh and a["type"] in ("credit_card", "auto_loan", "personal_loan", "mortgage"))
    return round(assets + h["home_value"] + h["vehicle_value"] - debts, 2)


def validate(rec: dict, convs: list[dict]) -> None:
    hh_ids = {h["id"] for h in rec["households"]}
    mem = {m["id"]: m for m in rec["members"]}
    acc = {a["id"]: a for a in rec["accounts"]}
    assert all(i.startswith("hh_") for i in hh_ids)
    assert all(m.startswith("mem_") and mem[m]["household_id"] in hh_ids for m in mem)
    for a in rec["accounts"]:
        assert a["id"].startswith("acct_") and a["household_id"] in hh_ids
        assert a["type"] in ALL_TYPES
        assert a["owner_member_ids"] and all(mem[m]["household_id"] == a["household_id"] for m in a["owner_member_ids"]), a["id"]
        assert a["balance"] >= 0, a["id"]
    for h in rec["households"]:
        mort = sum(a["balance"] for a in rec["accounts"] if a["household_id"] == h["id"] and a["type"] == "mortgage")
        assert h["home_value"] >= 0 and h["vehicle_value"] > 0
        assert (h["home_value"] == 0) == (h["id"] in ("hh_okafor", "hh_patel")), h["id"]  # renters
        assert h["home_value"] == 0 or h["home_value"] > 1.3 * mort, f"{h['id']}: mortgage not well below home value"
    assert net_worth(rec, "hh_rivera") > 250000, "Rivera must be clearly positive"
    assert {a["type"] for a in rec["accounts"]} == ALL_TYPES, "not all 8 account types covered"
    ids = [t["id"] for t in rec["transactions"]]
    assert len(ids) == len(set(ids)) and all(i.startswith("txn_") for i in ids)
    txn = rec["transactions"]
    for t in txn:
        assert t["account_id"] in acc and t["household_id"] == acc[t["account_id"]]["household_id"]
        assert t["date"] <= WIN_END.isoformat() or t.get("anomaly") == "impossible_value", t
    n_anom = sum(1 for t in txn if t.get("anomaly"))
    labelled = Counter(t["anomaly"] for t in txn if t.get("anomaly"))
    assert LABELS <= set(labelled), f"missing labels: {LABELS - set(labelled)}"
    non_outlier = sum(v for k, v in labelled.items() if k != "outlier")
    assert non_outlier / len(txn) < 0.03, f"anomalies too dense: {non_outlier}/{len(txn)}"
    assert {t["household_id"] for t in txn} == hh_ids
    assert all(o["id"].startswith("obl_") and o["account_id"] in acc for o in rec["obligations"])
    for c in rec["credit_profiles"]:
        assert c["member_id"] in mem
    assert len(convs) == 6
    for c in convs:
        assert c["id"].startswith("conv_") and c["household_id"] in hh_ids
        assert 12 <= len(c["turns"]) <= 30, (c["id"], len(c["turns"]))
        text = [t["text"] for t in c["turns"]]
        assert c["expected_goals"], c["id"]
        for g in c["expected_goals"]:
            assert g["id"].startswith("goal_") and g["household_id"] == c["household_id"]
            q = g.get("evidence_quote")
            assert q and any(q in t for t in text), f"evidence quote not verbatim in {c['id']}: {q!r}"
    assert any(c.get("scam_signals") for c in convs if c["household_id"] == "hh_nguyen")
    from collections import defaultdict
    per_hh = defaultdict(int)
    for c in convs:
        per_hh[c["household_id"]] += 1
    assert per_hh["hh_rivera"] == 2 and all(per_hh[h] == 1 for h in hh_ids - {"hh_rivera"})


def report(rec: dict, files: dict[str, str]) -> None:
    txn = rec["transactions"]
    print(f"{len(txn)} transactions; anomalies: {dict(Counter(t['anomaly'] for t in txn if t.get('anomaly')))}")
    by = defaultdict(list)
    for t in txn:
        if t.get("anomaly"):
            by[t["anomaly"]].append(t)
    for label, rows in sorted(by.items()):
        print(f"\n== {label} ({len(rows)})")
        for t in rows:
            print(f"  {t['id']} {t['household_id']} {t['account_id']} {t['date']} {t['amount']:>14,.2f}  {t['merchant'][:40]}")
    print("\n== net worth (deposits + home + vehicles - debts)")
    for h in rec["households"]:
        print(f"  {h['id']:<10} home {h['home_value']:>9,.0f}  vehicles {h['vehicle_value']:>7,.0f}  net worth {net_worth(rec, h['id']):>12,.2f}")
    print("\n== balances")
    for a in rec["accounts"]:
        print(f"  {a['id']:<34} {a['type']:<14} {a['balance']:>12,.2f}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--out", default=os.path.join(HERE, "seed"))
    ap.add_argument("--report", action="store_true", help="print anomaly ids and balances")
    args = ap.parse_args()

    rng = random.Random(f"keystone:{args.seed}:households")
    book, warns = build_all(rng)
    for w in warns:
        print("WARNING:", w, file=sys.stderr)
    rec = to_records(book)
    fees = [r for r in book.rows if r["tag"] == "fee"]
    facts = {"patel_overdraft_count": len(fees), "patel_overdraft_total": -sum(r["amount"] for r in fees),
             "patel_balance": next(a["balance"] for a in rec["accounts"] if a["id"] == "acct_patel_chk")}
    convs = build_conversations(facts)
    validate(rec, convs)
    proposals, votes = build_proposals(args.seed)
    validate_proposals(proposals, votes, rec)

    os.makedirs(args.out, exist_ok=True)
    data = dict(rec, conversations=convs, proposals=proposals, votes=votes)
    paths = {}
    for name in FILES:
        p = os.path.join(args.out, f"{name}.json")
        dump_list(p, data[name])
        paths[name] = p
    total = 0
    for name in FILES:
        size = os.path.getsize(paths[name])
        total += size
        print(f"{name + '.json':<22}{len(data[name]):>6} rows {size / 1024:>9.1f} KB")
    print(f"{'total':<22}{'':>6}      {total / 1024:>9.1f} KB   (as of {TODAY}, seed {args.seed})")
    plaid_dir = os.path.join(os.path.dirname(os.path.abspath(args.out)), "plaid")  # data/plaid next to data/seed
    os.makedirs(plaid_dir, exist_ok=True)
    plaid_path = os.path.join(plaid_dir, "sandbox_user.json")
    with open(plaid_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(dump_plaid_user(build_sandbox_user(args.seed)))
    print(f"{'plaid/sandbox_user.json':<22}{'':>6}      {os.path.getsize(plaid_path) / 1024:>9.1f} KB   (Plaid Sandbox custom user)")
    if args.report:
        report(rec, paths)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
