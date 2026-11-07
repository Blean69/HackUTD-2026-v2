"""The five synthetic households: members, accounts, ~6 months of transactions, credit, obligations."""
from __future__ import annotations

import datetime as dt

from ledger import (Book, EXCLUDED, TODAY, WIN_END, WIN_START, card_payments, clip_day, every, interest_credits,
                    loan_payment, lognorm, mark_duplicates, mark_garbled, monthly, monthly_dates, nth_weekday,
                     running_min, sprinkle, sweeps, transfer_monthly, weekday_dates, window_months)

D = dt.date

PERSONAS = {
    "hh_rivera": (
        "Marisol (38) and Daniel (41) Rivera live in Oak Cliff, Dallas with their kids Sofia (15) and Mateo (9) and "
        "Marisol's mother Elena (68). Marisol owns Rivera's Panadería, a neighbourhood bakery with about $1.3M of "
        "revenue in 2025; her owner draws arrive in lumps that follow catering orders and the holiday season. Daniel "
        "has steady W-2 pay as a logistics supervisor. Financially solid (good credit, home equity, healthy savings) "
        "but cash is lumpy, and money lives in six places. Their home is worth about $410k. They are weighing a second bakery location (about $250k "
        "build-out, maybe an SBA loan), Elena's rising medical costs and a college fund. Hero demo household: no "
        "planted fraud, one benign medical-bill outlier."),
    "hh_okafor": (
        "Amara (28, nurse) and Chidi (29, QA engineer) Okafor rent in Lakewood, Dallas. Student loans, a car loan and "
        "high credit-card utilization hold their scores down while they save a House Fund for a first home in about "
        "two years. A September account takeover drained $4,650 from the House Fund and a card-testing burst hit "
        "their cash-back card in August."),
    "hh_nguyen": (
        "Tom (72) and Linh (70) Nguyen are retired in Garland. Pension plus Social Security, a CD ladder, two IRAs and a "
        "paid-off house worth about $285k. On Oct 21 a caller posing as their grandson Kevin ('in jail, don't tell Mom and Dad') "
        "talked them into buying $2,000 of gift cards across four stores in two hours: the demo elder-scam case."),
    "hh_patel": (
        "Priya Patel (34) is a single parent in Arlington with an 8-year-old son, Aarav. Part-time dental-office "
        "payroll plus DoorDash, Instacart and Uber Eats earnings that swing week to week. Thin cushion, overdraft "
        "fees and a high-APR installment loan. Her credit union export is messy: duplicates, garbled merchant "
        "names, an impossible $9,999,999.99 coffee and postings dated in the future."),
    "hh_brooks": (
        "Terrence (46, operations manager) and Danielle (44, assistant principal) Brooks live in DeSoto with their "
        "16-year-old Jordan and Terrence's father Walter (74), who receives Social Security and helps with bills but "
        "needs a part-time home aide. A 3.4% mortgage, an SUV loan and a 529 plan for Jordan that is behind "
        "target. Home worth about $330k. Steady incomes, tight sandwich-generation budget; clean books apart from a benign roof-repair "
        "outlier and one double-posted pharmacy charge."),
}

# id, name, city, home_value (0 = renting), vehicle_value (market value of the household's cars)
HOUSEHOLDS = [
    ("hh_rivera", "Rivera Family", "Dallas", 410000, 47000),     # F-150 + Marisol's minivan
    ("hh_okafor", "Okafor Household", "Dallas", 0, 19500),       # renters; 2022 Civic
    ("hh_nguyen", "Nguyen Household", "Garland", 285000, 22000), # house paid off; two older cars
    ("hh_patel", "Patel Household", "Arlington", 0, 8900),       # renter; 2017 Sentra (loan is nearly underwater)
    ("hh_brooks", "Brooks Family", "DeSoto", 330000, 45000),     # SUV + Danielle's sedan
]

MEMBERS = [
    # id, household, name, age, role, income
    ("mem_rivera_marisol", "hh_rivera", "Marisol Rivera", 38, "parent", 72000),
    ("mem_rivera_daniel", "hh_rivera", "Daniel Rivera", 41, "parent", 84000),
    ("mem_rivera_sofia", "hh_rivera", "Sofia Rivera", 15, "child", 0),
    ("mem_rivera_mateo", "hh_rivera", "Mateo Rivera", 9, "child", 0),
    ("mem_rivera_elena", "hh_rivera", "Elena Morales", 68, "grandparent", 14208),
    ("mem_okafor_amara", "hh_okafor", "Amara Okafor", 28, "other", 74000),
    ("mem_okafor_chidi", "hh_okafor", "Chidi Okafor", 29, "other", 68000),
    ("mem_nguyen_tom", "hh_nguyen", "Thanh 'Tom' Nguyen", 72, "grandparent", 56412),
    ("mem_nguyen_linh", "hh_nguyen", "Linh Nguyen", 70, "grandparent", 15156),
    ("mem_patel_priya", "hh_patel", "Priya Patel", 34, "parent", 42500),
    ("mem_patel_aarav", "hh_patel", "Aarav Patel", 8, "child", 0),
    ("mem_brooks_terrence", "hh_brooks", "Terrence Brooks", 46, "parent", 96000),
    ("mem_brooks_danielle", "hh_brooks", "Danielle Brooks", 44, "parent", 71500),
    ("mem_brooks_jordan", "hh_brooks", "Jordan Brooks", 16, "child", 4300),
    ("mem_brooks_walter", "hh_brooks", "Walter Brooks", 74, "grandparent", 24600),
]

# member -> (score, hard_inquiries_12m, oldest_account_years, late_payments_24m)
CREDIT = {
    "mem_rivera_marisol": (741, 1, 16, 0), "mem_rivera_daniel": (726, 2, 19, 0), "mem_rivera_elena": (712, 0, 34, 0),
    "mem_okafor_amara": (671, 3, 9, 0), "mem_okafor_chidi": (648, 2, 8, 1),
    "mem_nguyen_tom": (812, 0, 41, 0), "mem_nguyen_linh": (806, 0, 38, 0),
    "mem_patel_priya": (571, 4, 7, 3),
    "mem_brooks_terrence": (752, 1, 22, 0), "mem_brooks_danielle": (768, 0, 21, 0), "mem_brooks_walter": (791, 0, 45, 0),
}

SEASON_ELEC = {5: 0.8, 6: 1.1, 7: 1.5, 8: 1.75, 9: 1.45, 10: 0.9, 11: 0.7}
SEASON_GAS = {5: 0.9, 6: 0.6, 7: 0.5, 8: 0.5, 9: 0.5, 10: 0.8, 11: 1.5}
WEEKEND = {4: 1.2, 5: 1.7, 6: 1.5}


def _income(b, aid, dates, amount, merchant, desc, cat="income", rec=True):
    for d in dates:
        b.tx(aid, d, amount, merchant, cat, desc, rec)


# ======================================================================= RIVERA
def build_rivera(b: Book):
    hh, city, rng = "hh_rivera", "Dallas", b.rng
    chk, sav, col, ira = "acct_rivera_chk", "acct_rivera_sav", "acct_rivera_college", "acct_rivera_ira"
    mtg, auto, c1, c2 = "acct_rivera_mtg", "acct_rivera_auto", "acct_rivera_card1", "acct_rivera_card2"
    M_, D_, E_, S_ = "mem_rivera_marisol", "mem_rivera_daniel", "mem_rivera_elena", "mem_rivera_sofia"
    both = [M_, D_]
    b.acct(chk, hh, both + [E_], "checking", "Keystone Bank", "Joint Checking", 4420.00, "2014-03-11", rate_pct=0.01)
    b.acct(sav, hh, both, "savings", "Keystone Bank", "Emergency Fund", 14200.00, "2016-09-02", rate_pct=4.10)
    b.acct(col, hh, both, "savings", "Lone Star Credit Union", "College Fund (Sofia & Mateo)", 21500.00, "2018-01-20", rate_pct=4.00)
    b.acct(ira, hh, [D_], "ira", "Summit Retirement Services", "Daniel's Rollover IRA", 118400.00, "2015-05-08")
    b.acct(mtg, hh, both, "mortgage", "Trinity Federal", "Home Mortgage", 247300.00, "2019-06-14", rate_pct=3.875,
           monthly_payment=2218.44, maturity_date="2049-06-01")
    b.acct(auto, hh, [D_], "auto_loan", "Lone Star Credit Union", "Daniel's F-150 Loan", 19800.00, "2023-03-15", rate_pct=5.90,
           monthly_payment=612.30, maturity_date="2029-03-15")
    b.acct(c1, hh, both, "credit_card", "Cedar Springs Card Services", "Rewards Visa", 0, "2015-11-30", rate_pct=21.99,
           credit_limit=15000, monthly_payment=35)
    b.acct(c2, hh, [M_], "credit_card", "Gulf & Plains Bank", "Gas Rewards Mastercard", 0, "2017-02-08", rate_pct=19.49,
           credit_limit=8000, monthly_payment=35)

    # --- income: Daniel's steady payroll, Elena's Social Security, Marisol's lumpy bakery draws
    _income(b, chk, every(D(2026, 10, 30)), 2486.31, "Lone Star Freight Services",
            "DIRECT DEP LONE STAR FREIGHT SVCS PAYROLL PPD ID: 1750294")
    monthly(b, chk, 3, 1184.00, "Social Security Administration", "SSA TREAS 310 XXSOC SEC", "income")
    d = WIN_START + dt.timedelta(days=rng.randint(0, 4))
    while d <= WIN_END:
        peak = 1.25 if d.month >= 9 else 1.0
        b.tx(chk, d, lognorm(rng, 1150 * peak, 0.55, 600, 4200), "Rivera's Panaderia LLC", "income",
             "ONLINE TRANSFER FROM RIVERAS PANADERIA LLC OWNER DRAW", False)
        d += dt.timedelta(days=rng.randint(7, 16))
    b.tx(chk, D(2026, 7, 2), 6200.00, "Rivera's Panaderia LLC", "income",
         "ONLINE TRANSFER FROM RIVERAS PANADERIA LLC QTRLY DISTRIBUTION", False)
    b.tx(chk, D(2026, 10, 2), 7400.00, "Rivera's Panaderia LLC", "income",
         "ONLINE TRANSFER FROM RIVERAS PANADERIA LLC QTRLY DISTRIBUTION", False)
    for d_ in (D(2026, 6, 15), D(2026, 9, 15)):
        b.tx(chk, d_, -4800.00, "IRS", "taxes", "IRS USATAXPYMT 1040ES EST TAX", False)

    # --- fixed bills (obligations)
    monthly(b, chk, 3, -212.88, "State Farm", "STATE FARM INSURANCE AUTO+HOME", "insurance", ob=("State Farm auto + home", "insurance"))
    monthly(b, chk, 6, -79.99, "Spectrum", "SPECTRUM INTERNET 877-555-0112", "utilities", ob=("Spectrum internet", "bill"))
    monthly(b, chk, 9, -88.00, "City of Dallas Water", "CITY OF DALLAS WATER UTILITIES", "utilities", jitter=0.12, ob=("City of Dallas water", "bill"))
    monthly(b, chk, 15, -168.00, "TXU Energy", "TXU ENERGY ONLINE PMT", "utilities", jitter=0.06, season=SEASON_ELEC, ob=("TXU Energy electric", "bill"))
    monthly(b, chk, 18, -188.45, "AT&T Wireless", "AT&T*BILL PAYMENT", "utilities", ob=("AT&T family wireless plan", "bill"))
    monthly(b, chk, 22, -52.00, "Atmos Energy", "ATMOS ENERGY WEB PMT", "utilities", jitter=0.1, season=SEASON_GAS, ob=("Atmos Energy gas", "bill"))
    monthly(b, chk, 1, -145.00, "Metroplex Volleyball Club", "METROPLEX VOLLEYBALL CLUB DUES", "kids", ob=("Sofia's volleyball club dues", "bill"))
    monthly(b, chk, 1, -320.00, "Oak Cliff Kids Academy", "OAK CLIFF KIDS ACADEMY TUITION", "education", ob=("Mateo's after-school academy", "tuition"))
    monthly(b, chk, 18, -185.00, "Salinas Orthodontics", "SALINAS ORTHODONTICS PMT PLAN", "health", ob=("Sofia's braces payment plan", "bill"))
    monthly(b, chk, 14, -15.49, "Netflix", "NETFLIX.COM", "subscriptions", ob=("Netflix", "subscription"))
    monthly(b, chk, 21, -16.99, "Spotify", "SPOTIFY USA", "subscriptions", ob=("Spotify Family", "subscription"))
    monthly(b, chk, 9, -13.99, "Disney+", "DISNEYPLUS", "subscriptions", ob=("Disney+", "subscription"))
    monthly(b, chk, 28, -14.99, "Amazon Prime", "AMAZON PRIME*MEMBERSHIP", "subscriptions", ob=("Amazon Prime", "subscription"))
    loan_payment(b, mtg, chk, 1, 2218.44, "Trinity Federal", "TRINITY FEDERAL MTG PMT {d:%m/%d}", "mortgage", "Mortgage (Trinity Federal)")
    loan_payment(b, auto, chk, 12, 612.30, "Lone Star Credit Union", "LONE STAR CU AUTO LOAN PMT {d:%m/%d}", "loan_payment", "F-150 auto loan (Lone Star CU)")
    transfer_monthly(b, chk, col, 5, 500.0, "ONLINE TRANSFER TO COLLEGE FUND", "TRANSFER FROM JOINT CHECKING", "savings", ("College fund contribution", "bill"))
    transfer_monthly(b, chk, ira, 10, 250.0, "SUMMIT RETIREMENT IRA CONTRIBUTION", "CONTRIBUTION - EMPLOYEE", "savings")

    # --- everyday spending
    kw = dict(dow=WEEKEND)
    sprinkle(b, hh, city, "groceries", [("heb", 3), ("fiesta", 3), ("tomthumb", 2), ("aldi", 1)], 3.0, 78, 0.55, 12, 330, [(chk, .6), (c1, .4)], **kw)
    sprinkle(b, hh, city, "groceries", [("costco", 1)], 0.25, 190, 0.35, 70, 380, [(c1, 1)], varied=False)
    sprinkle(b, hh, city, "dining", [("chickfila", 3), ("whataburger", 2), ("torchys", 2), ("primos", 2), ("elfenix", 1), ("mcdonalds", 1), ("starbucks", 2)],
             2.8, 24, 0.6, 5, 130, [(c1, .8), (chk, .2)], **kw)
    sprinkle(b, hh, city, "fuel", [("qt", 3), ("shell", 2), ("exxon", 2), ("racetrac", 1)], 2.0, 46, 0.3, 22, 82, [(c2, 1)])
    sprinkle(b, hh, city, "shopping", [("target", 3), ("amazon", 4), ("walmartshop", 2), ("homedepot", 1), ("hobbylobby", 1), ("ross", 1), ("dollartree", 1), ("kohls", 1)],
             3.0, 38, 0.85, 5, 340, [(c1, .5), (chk, .3), (c2, .2)])
    sprinkle(b, hh, city, "kids", [("dicks", 2), ("fivebelow", 2), ("bnnoble", 1), ("oldnavy", 2)], 0.8, 42, 0.6, 8, 200, [(c1, 1)])
    sprinkle(b, hh, city, "health", [("cvs", 1)], 0.9, 31, 0.7, 4, 160, [(chk, 1)])
    sprinkle(b, hh, city, "entertainment", [("amc", 2), ("zoo", 1), ("sixflags", 1), ("mainevent", 1)], 0.35, 62, 0.6, 18, 240, [(c1, 1)], dow=WEEKEND)
    monthly(b, chk, 20, -65.0, "Mercy Oaks Cardiology", "MERCY OAKS CARDIOLOGY COPAY", "health", rec=False, jitter=0.1)
    b.tx(c1, D(2026, 6, 27), -1184.60, "Hotel Lumen Corpus Christi", "travel", "HOTEL LUMEN CORPUS CHRISTI TX", False)
    b.tx(c2, D(2026, 6, 28), -236.14, "Buc-ee's", "fuel", "BUC-EE'S #22 WACO TX", False)
    b.tx(chk, D(2026, 8, 8), -420.00, "Ross Stores", "kids", "PURCHASE AUTHORIZED ON 08/08 ROSS STORES #1442 DALLAS TX BACK TO SCHOOL", False)
    # --- benign outlier: Grandma's hospital bill
    b.tx(chk, D(2026, 9, 24), -3412.18, "Mercy Oaks Hospital", "health", "MERCY OAKS HOSPITAL PATIENT PMT ACCT 40-5521", False, anomaly="outlier")

    card_payments(b, c1, chk, 21, "Cedar Springs Card Services", "full", ob_name="Rewards Visa payment")
    card_payments(b, c2, chk, 24, "Gulf & Plains Bank", "revolve", owed0=1600.0, target_final=2050.0, ob_name="Gas Mastercard payment")
    interest_credits(b, sav, 4.10, 14000)
    interest_credits(b, col, 4.00, 20500)
    sweeps(b, chk, sav, 5200.0, 5200.0, 4420.0, frac=0.7)
    b.accts[chk]["_s0"] = 5200.0


# ======================================================================= OKAFOR
def build_okafor(b: Book):
    hh, city, rng = "hh_okafor", "Dallas", b.rng
    chk, sav, ca, cb = "acct_okafor_chk", "acct_okafor_sav", "acct_okafor_card_a", "acct_okafor_card_b"
    sla, slc, auto = "acct_okafor_student_amara", "acct_okafor_student_chidi", "acct_okafor_auto"
    A, C = "mem_okafor_amara", "mem_okafor_chidi"
    b.acct(chk, hh, [A, C], "checking", "Keystone Bank", "Joint Checking", 2950.00, "2021-08-19", rate_pct=0.01)
    b.acct(sav, hh, [A, C], "savings", "Lone Star Credit Union", "House Fund", 22300.00, "2022-01-10", rate_pct=4.20)
    b.acct(ca, hh, [A], "credit_card", "Gulf & Plains Bank", "Cash Rewards Visa", 0, "2018-04-03", rate_pct=24.99,
           credit_limit=8000, monthly_payment=210)
    b.acct(cb, hh, [C], "credit_card", "Lone Star Department Stores", "Store Card", 0, "2019-10-12", rate_pct=27.99,
           credit_limit=5000, monthly_payment=140)
    b.acct(sla, hh, [A], "personal_loan", "Federal Student Aid Servicer", "Student Loans (Amara)", 38400.00, "2016-08-25",
           rate_pct=5.50, monthly_payment=412.00, maturity_date="2036-08-25")
    b.acct(slc, hh, [C], "personal_loan", "Redbud Student Lending", "Student Loan (Chidi, private)", 24900.00, "2017-08-30",
           rate_pct=7.20, monthly_payment=296.00, maturity_date="2032-08-30")
    b.acct(auto, hh, [C], "auto_loan", "Lone Star Credit Union", "2022 Honda Civic Loan", 13100.00, "2022-06-05", rate_pct=6.40,
           monthly_payment=398.00, maturity_date="2027-06-05")

    _income(b, chk, [d for d in monthly_dates(1)] + [d for d in monthly_dates(15)], 2298.40, "Metro North Health System",
            "DIRECT DEP METRO NORTH HEALTH SYS PAYROLL PPD ID: 1620847")
    _income(b, chk, every(D(2026, 10, 29)), 1983.12, "Brightfield Software",
            "DIRECT DEP BRIGHTFIELD SOFTWARE INC PAYROLL PPD ID: 1840233")
    monthly(b, chk, 1, -1725.00, "Lakewood Residences", "ACH LAKEWOOD RESIDENCES LP RENT", "rent", ob=("Rent (Lakewood Residences)", "bill"))
    monthly(b, chk, 3, -14.00, "Lone Star Mutual Insurance", "LONE STAR MUTUAL RENTERS INS", "insurance", ob=("Renters insurance", "insurance"))
    monthly(b, chk, 11, -168.00, "Lone Star Mutual Insurance", "LONE STAR MUTUAL AUTO INS", "insurance", ob=("Auto insurance", "insurance"))
    monthly(b, chk, 12, -64.00, "Reliant Energy", "RELIANT ENERGY RETAIL", "utilities", jitter=0.1, season=SEASON_ELEC, ob=("Reliant electric", "bill"))
    monthly(b, chk, 8, -70.00, "Spectrum", "SPECTRUM INTERNET 877-555-0112", "utilities", ob=("Spectrum internet", "bill"))
    monthly(b, chk, 17, -118.00, "Verizon Wireless", "VZWRLSS*APOCC VISE", "utilities", ob=("Verizon (2 lines)", "bill"))
    for nm, desc, day, amt in (("Hulu", "HULU", 4, 17.99), ("Max", "MAX.COM", 19, 16.99), ("Netflix", "NETFLIX.COM", 22, 15.49),
                               ("Spotify", "SPOTIFY USA", 13, 11.99), ("Crunch Fitness", "CRUNCH FITNESS MEMBERSHIP", 7, 24.99),
                               ("Peloton Digital", "PELOTON DIGITAL MEMBERSHIP", 25, 12.99)):
        monthly(b, chk, day, -amt, nm, desc, "subscriptions", ob=(nm, "subscription"))
    loan_payment(b, sla, chk, 6, 412.00, "Federal Student Aid Servicer", "FED STUDENT AID SERVICER {d:%m/%d}", "loan_payment", "Student loans (Amara)")
    loan_payment(b, slc, chk, 20, 296.00, "Redbud Student Lending", "REDBUD STUDENT LENDING ACH {d:%m/%d}", "loan_payment", "Student loan (Chidi)")
    loan_payment(b, auto, chk, 9, 398.00, "Lone Star Credit Union", "LONE STAR CU AUTO LOAN PMT {d:%m/%d}", "loan_payment", "Civic auto loan")
    transfer_monthly(b, chk, sav, 2, 600.0, "ONLINE TRANSFER TO HOUSE FUND", "TRANSFER FROM JOINT CHECKING", "savings", ("House Fund contribution", "bill"))

    kw = dict(dow=WEEKEND)
    sprinkle(b, hh, city, "groceries", [("kroger", 3), ("tomthumb", 3), ("aldi", 2), ("sprouts", 1), ("target", 1)], 2.2, 61, 0.5, 9, 210, [(chk, .55), (ca, .45)], **kw)
    sprinkle(b, hh, city, "dining", [("chipotle", 3), ("torchys", 3), ("starbucks", 3), ("doordash", 3), ("jerseymikes", 1), ("primos", 1), ("pizzapatron", 1)],
             4.2, 27, 0.6, 6, 140, [(ca, .85), (chk, .15)], **kw)
    sprinkle(b, hh, city, "fuel", [("qt", 3), ("shell", 2), ("racetrac", 1)], 1.3, 38, 0.3, 20, 62, [(ca, .5), (chk, .5)])
    sprinkle(b, hh, city, "shopping", [("amazon", 5), ("target", 2), ("walmartshop", 1), ("tjmaxx", 1), ("bestbuy", 1)], 2.0, 44, 0.85, 6, 320, [(cb, .55), (ca, .3), (chk, .15)])
    sprinkle(b, hh, city, "transport", [("uber", 3), ("dart", 1)], 0.9, 21, 0.5, 6, 70, [(ca, .7), (chk, .3)])
    sprinkle(b, hh, city, "health", [("cvs", 1), ("walgreens", 1)], 0.5, 24, 0.7, 4, 120, [(chk, 1)])
    sprinkle(b, hh, city, "entertainment", [("amc", 2), ("topgolf", 1), ("mainevent", 1)], 0.4, 58, 0.6, 15, 200, [(ca, .7), (chk, .3)], dow=WEEKEND)
    b.tx(ca, D(2026, 7, 18), -486.20, "Southwest Airlines", "travel", "SOUTHWEST AIRLINES 5262 800-555-0171 TX", False)
    b.tx(cb, D(2026, 6, 20), -312.45, "Lone Star Department Stores", "shopping", "LONE STAR DEPT STORES #0231 DALLAS TX", False)

    # --- anomalies
    mark_duplicates(b, chk, 1)
    mark_duplicates(b, ca, 1)
    mark_garbled(b, ca, 1, modes=["moji"])
    # card testing: seven ~$1 charges at one unknown merchant in about seven minutes
    for i, (t, amt) in enumerate([("14:02", 1.00), ("14:03", 1.00), ("14:04", 1.01), ("14:05", 1.12), ("14:06", 1.00), ("14:07", 1.50), ("14:08", 0.99)]):
        b.tx(ca, D(2026, 8, 26), -amt, "TMRW PAY 7731", "shopping", f"TMRW PAY 7731 800-555-0143 FL {t}", False, anomaly="card_testing")
    # account takeover: new payee + large transfer out of House Fund at 3 a.m.
    b.tx(sav, D(2026, 9, 17), -1.00, "Zelle - T Bryant (new payee)", "transfer",
         "ZELLE SEND TO NEW PAYEE T BRYANT - PAYEE ADDED 02:51 CT - TEST PAYMENT 02:58 CT - NEW DEVICE", False, anomaly="account_takeover")
    b.tx(sav, D(2026, 9, 17), -4650.00, "Zelle - T Bryant (new payee)", "transfer",
         "ZELLE SEND TO NEW PAYEE T BRYANT - SENT 03:07 CT - NEW DEVICE - IP OUTSIDE USUAL AREA", False, anomaly="account_takeover")

    card_payments(b, ca, chk, 18, "Gulf & Plains Bank", "revolve", owed0=6150.0, target_final=6900.0, ob_name="Cash Rewards Visa payment")
    card_payments(b, cb, chk, 25, "Lone Star Department Stores", "revolve", owed0=3300.0, target_final=3050.0, ob_name="Store card payment")
    interest_credits(b, sav, 4.20, 21000)
    sweeps(b, chk, sav, 2800.0, 2800.0, 2950.0, frac=0.6)
    b.accts[chk]["_s0"] = 2800.0


# ======================================================================= NGUYEN
def build_nguyen(b: Book):
    hh, city, rng = "hh_nguyen", "Garland", b.rng
    chk, sav, cd1, cd2, cd3 = "acct_nguyen_chk", "acct_nguyen_sav", "acct_nguyen_cd_6mo", "acct_nguyen_cd_12mo", "acct_nguyen_cd_24mo"
    ira_t, ira_l, card = "acct_nguyen_ira_tom", "acct_nguyen_roth_linh", "acct_nguyen_card"
    T, L = "mem_nguyen_tom", "mem_nguyen_linh"
    b.acct(chk, hh, [T, L], "checking", "Keystone Bank", "Joint Checking", 9420.00, "1998-05-04", rate_pct=0.01)
    b.acct(sav, hh, [T, L], "savings", "Keystone Bank", "Rainy Day Savings", 28000.00, "2009-02-17", rate_pct=4.00)
    b.acct(cd1, hh, [T, L], "cd", "Keystone Bank", "6-Month CD", 25000.00, "2026-06-05", rate_pct=4.80, maturity_date="2026-12-05")
    b.acct(cd2, hh, [T, L], "cd", "Keystone Bank", "12-Month CD", 50000.00, "2026-02-14", rate_pct=4.60, maturity_date="2027-02-14")
    b.acct(cd3, hh, [T, L], "cd", "Trinity Federal", "24-Month CD", 75000.00, "2025-08-30", rate_pct=4.20, maturity_date="2027-08-30")
    b.acct(ira_t, hh, [T], "ira", "Summit Retirement Services", "Tom's Traditional IRA", 356200.00, "1996-03-01")
    b.acct(ira_l, hh, [L], "ira", "Summit Retirement Services", "Linh's Roth IRA", 118900.00, "2004-04-12")
    b.acct(card, hh, [T, L], "credit_card", "Cedar Springs Card Services", "Cash Rewards Visa", 0, "1999-07-19", rate_pct=19.99,
           credit_limit=12000, monthly_payment=35)

    monthly(b, chk, 1, 2215.00, "Meridian Aerospace Pension", "MERIDIAN AEROSPACE PENSION PPD ID: 1411209", "income")
    monthly(b, chk, 3, 2486.00, "Social Security Administration", "SSA TREAS 310 XXSOC SEC", "income")
    for y, m in window_months():
        d = nth_weekday(y, m, 2, 2)
        if WIN_START <= d <= WIN_END:
            b.tx(chk, d, 1263.00, "Social Security Administration", "income", "SSA TREAS 310 XXSOC SEC", True)
    for d in (D(2026, 9, 30),):
        b.tx(ira_t, d, -4150.00, "Summit Retirement Services", "income", "RMD DISTRIBUTION - FEDERAL W/H 10%", False)
        b.tx(chk, d, 3735.00, "Summit Retirement Services", "income", "SUMMIT RETIREMENT RMD DIST NET", False)
    # fixed bills
    monthly(b, chk, 4, -187.40, "Sunbelt Medicare Supplement", "SUNBELT MED SUPP PLAN G TOM", "insurance", ob=("Medicare supplement (Tom)", "insurance"))
    monthly(b, chk, 4, -171.20, "Sunbelt Medicare Supplement", "SUNBELT MED SUPP PLAN G LINH", "insurance", ob=("Medicare supplement (Linh)", "insurance"))
    monthly(b, chk, 7, -41.00, "PartD Rx Plan", "PARTD RX PLAN PREMIUM", "insurance", ob=("Part D drug plan", "insurance"))
    monthly(b, chk, 10, -228.00, "Texas Farm Mutual", "TEXAS FARM MUTUAL HOME INS", "insurance", ob=("Homeowners insurance", "insurance"))
    monthly(b, chk, 14, -190.00, "Garland Power & Light", "GARLAND POWER & LIGHT", "utilities", jitter=0.06, season=SEASON_ELEC, ob=("Garland Power & Light", "bill"))
    monthly(b, chk, 20, -45.00, "Atmos Energy", "ATMOS ENERGY WEB PMT", "utilities", jitter=0.1, season=SEASON_GAS, ob=("Atmos Energy gas", "bill"))
    monthly(b, chk, 12, -74.00, "City of Garland Utilities", "CITY OF GARLAND UTILITIES WTR/SWR", "utilities", jitter=0.1, ob=("City of Garland water", "bill"))
    monthly(b, chk, 16, -95.00, "AT&T", "AT&T*BILL PAYMENT", "utilities", ob=("AT&T mobile", "bill"))
    monthly(b, chk, 9, -90.00, "Spectrum", "SPECTRUM INTERNET 877-555-0112", "utilities", ob=("Spectrum internet+TV", "bill"))
    monthly(b, chk, 2, -150.00, "Vietnamese Catholic Community", "OFFERING VIETNAMESE CATHOLIC COMM", "charity", rec=True)
    monthly(b, chk, 11, -17.99, "Netflix", "NETFLIX.COM", "subscriptions", ob=("Netflix", "subscription"))

    kw = dict(dow={0: 1.2, 1: 1.2, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.1, 6: 0.5})
    sprinkle(b, hh, city, "groceries", [("ranch99", 4), ("hmart", 3), ("kroger", 2), ("fiesta", 1)], 3.0, 66, 0.5, 9, 190, [(chk, .75), (card, .25)], **kw)
    sprinkle(b, hh, city, "dining", [("pho", 4), ("banhmi", 3), ("dairyqueen", 1), ("mcdonalds", 1), ("chickfila", 1)], 2.6, 26, 0.5, 6, 85, [(chk, .6), (card, .4)], **kw)
    sprinkle(b, hh, city, "fuel", [("kroger", 1), ("qt", 2), ("shell", 1)], 0.9, 36, 0.3, 20, 55, [(card, 0.6), (chk, .4)])
    sprinkle(b, hh, city, "shopping", [("walmartshop", 3), ("target", 1), ("amazon", 2), ("lowes", 1)], 1.1, 33, 0.7, 6, 190, [(chk, .5), (card, .5)])
    sprinkle(b, hh, city, "health", [("cvs", 2), ("walgreens", 1)], 1.0, 28, 0.6, 4, 140, [(chk, 1)])
    b.tx(chk, D(2026, 8, 15), -100.00, "Zelle - Kevin Nguyen", "gifts", "ZELLE PAYMENT TO KEVIN NGUYEN - BIRTHDAY", False)
    b.tx(chk, D(2026, 7, 21), -312.00, "Garland Family Dental", "health", "GARLAND FAMILY DENTAL CLEANING+XRAY", False)
    b.tx(chk, D(2026, 8, 6), -1240.00, "Garland Family Dental", "health", "GARLAND FAMILY DENTAL CROWN #19", False, anomaly="outlier")
    b.tx(card, D(2026, 9, 5), -1380.00, "Hotel & Flights Houston", "travel", "SOUTHWEST AIRLINES 5262 + HOTEL HOUSTON TX", False)
    b.tx(chk, D(2026, 7, 4), -600.00, "Zelle - Kevin Nguyen", "gifts", "ZELLE PAYMENT TO KEVIN NGUYEN - GRAD SCHOOL BOOKS", False)
    b.tx(chk, D(2026, 6, 20), -950.00, "Garland Roofing & Gutters", "home_repair", "GARLAND ROOFING & GUTTERS GUTTER REPAIR", False)
    b.tx(card, D(2026, 6, 12), -684.20, "Southwest Airlines", "travel", "SOUTHWEST AIRLINES 5262 800-555-0171 TX", False)
    # the only gift cards in six months are the four scam purchases (about 13:04-15:02 on Oct 21)
    for t, key, store in (("13:04", "cvs", "CVS/PHARMACY #4421 GARLAND TX"), ("13:41", "walgreens", "WALGREENS #7710 GARLAND TX"),
                          ("14:25", "target", "TARGET T-2108 ROWLETT TX"), ("15:02", "kroger", "KROGER #571 GARLAND TX")):
        name = M_NAME[key]
        b.tx(chk, D(2026, 10, 21), -500.00, name, "gift_cards", f"PURCHASE AUTHORIZED ON 10/21 {store} GIFT CARD {t}", False, anomaly="scam_payment")

    card_payments(b, card, chk, 23, "Cedar Springs Card Services", "full", ob_name="Visa payment (paid in full)")
    for aid, apy, est in ((sav, 4.00, 27500),):
        interest_credits(b, aid, apy, est)
    for aid, apy, est, day in ((cd1, 4.80, 25000, 5), (cd2, 4.60, 50000, 14), (cd3, 4.20, 75000, 30)):
        interest_credits(b, aid, apy, est, day=day)
    sweeps(b, chk, sav, 9800.0, 9800.0, 9420.0, frac=0.6)
    b.accts[chk]["_s0"] = 9800.0


M_NAME = {"cvs": "CVS Pharmacy", "walgreens": "Walgreens", "target": "Target", "kroger": "Kroger"}


# ======================================================================= PATEL
def build_patel(b: Book):
    hh, city, rng = "hh_patel", "Arlington", b.rng
    chk, sav, card, auto, pl = "acct_patel_chk", "acct_patel_sav", "acct_patel_card", "acct_patel_auto", "acct_patel_loan"
    P = "mem_patel_priya"
    b.acct(chk, hh, [P], "checking", "Prairie Community Bank", "Everyday Checking", 164.30, "2019-02-25", rate_pct=0.01)
    b.acct(sav, hh, [P], "savings", "Prairie Community Bank", "Starter Savings", 212.40, "2019-02-25", rate_pct=0.50)
    b.acct(card, hh, [P], "credit_card", "Cedar Springs Card Services", "Secured Card", 0, "2021-09-14", rate_pct=29.99,
           credit_limit=1500, monthly_payment=40)
    b.acct(auto, hh, [P], "auto_loan", "Cedar Springs Auto Finance", "2017 Nissan Sentra Loan", 8420.00, "2023-01-20", rate_pct=12.90,
           monthly_payment=286.55, maturity_date="2028-01-20")
    b.acct(pl, hh, [P], "personal_loan", "QuickRise Installment", "Installment Loan", 1060.00, "2026-02-03", rate_pct=34.90,
           monthly_payment=142.00, maturity_date="2027-02-03")

    _income(b, chk, every(D(2026, 10, 30)), 762.18, "Arlington Family Dental", "DIRECT DEP ARLINGTON FAMILY DENTAL PAYROLL PPD ID: 1930041")
    # gig income: lumpy, with a few thin weeks
    for d in weekday_dates(1):
        if rng.random() < 0.9:
            b.tx(chk, d, lognorm(rng, 205, 0.45, 70, 420), "DoorDash", "income", "DOORDASH, INC. PAYMENT 855-555-0166", False)
    for d in weekday_dates(3):
        if rng.random() < 0.7:
            b.tx(chk, d, lognorm(rng, 135, 0.5, 40, 300), "Uber", "income", "UBER USA 6787 WEEKLY PAYOUT", False)
    d = WIN_START
    while d <= WIN_END:
        if rng.random() < 0.35:
            b.tx(chk, d, lognorm(rng, 52, 0.45, 18, 130), "Instacart", "income", "INSTACART INSTANT CASHOUT", False)
        d += dt.timedelta(days=1)
    for d in (D(2026, 6, 19), D(2026, 8, 14), D(2026, 10, 9)):
        b.tx(chk, d, lognorm(rng, 340, 0.2, 250, 400), "Child support", "income", "TX OAG CHILD SUPPORT DISBURSEMENT", False)

    monthly(b, chk, 5, -1285.00, "Oakview Apartments", "ONLINE PMT OAKVIEW APARTMENTS RENT", "rent", ob=("Rent (Oakview Apartments, late fee after the 7th)", "bill"))
    for r in b.rows:  # paid late twice: shifted to the 8th, with a $75 late fee
        if r["account_id"] == chk and r["merchant"] == "Oakview Apartments" and (r["date"].month, r["date"].day) in ((8, 5), (10, 5)):
            r["date"] = r["date"].replace(day=8)
            b.tx(chk, r["date"], -75.00, "Oakview Apartments", "fees", "OAKVIEW APARTMENTS LATE FEE", False)
    monthly(b, chk, 13, -148.00, "Safe Harbor Auto Insurance", "SAFE HARBOR AUTO INS", "insurance", ob=("Auto insurance", "insurance"))
    monthly(b, chk, 8, -55.00, "Boost Mobile", "BOOST MOBILE AUTOPAY", "utilities", ob=("Boost Mobile", "bill"))
    monthly(b, chk, 16, -92.00, "TXU Energy", "TXU ENERGY ONLINE PMT", "utilities", jitter=0.08, season=SEASON_ELEC, ob=("TXU Energy electric", "bill"))
    monthly(b, chk, 20, -52.00, "City of Arlington Water", "CITY OF ARLINGTON WATER UTIL", "utilities", jitter=0.1, ob=("City of Arlington water", "bill"))
    monthly(b, chk, 9, -9.99, "Netflix", "NETFLIX.COM", "subscriptions", ob=("Netflix", "subscription"))
    for d in weekday_dates(0):
        b.tx(chk, d, -55.00, "Bright Futures After-School", "education", "BRIGHT FUTURES AFTER-SCHOOL TUITN", True)
    b.obligation(chk, "After-school care (weekly)", 220.00, 1, "tuition")
    loan_payment(b, auto, chk, 20, 286.55, "Cedar Springs Auto Finance", "CEDAR SPRINGS AUTO FIN PMT {d:%m/%d}", "loan_payment", "Sentra auto loan")
    loan_payment(b, pl, chk, 10, 142.00, "QuickRise Installment", "QUICKRISE INSTALLMENT ACH {d:%m/%d}", "loan_payment", "Installment loan (QuickRise)")

    sprinkle(b, hh, city, "groceries", [("aldi", 4), ("walmart", 4), ("fiesta", 2), ("savealot", 2)], 2.5, 41, 0.55, 8, 130, [(chk, .8), (card, .2)], dow=WEEKEND)
    sprinkle(b, hh, city, "fuel", [("qt", 3), ("shell", 2), ("racetrac", 2), ("exxon", 1)], 3.4, 26, 0.45, 8, 48, [(chk, .9), (card, .1)])
    sprinkle(b, hh, city, "dining", [("mcdonalds", 3), ("sonic", 3), ("dairyqueen", 1), ("pizzapatron", 2), ("starbucks", 1), ("canes", 1)], 2.8, 13, 0.5, 4, 42, [(chk, .9), (card, .1)])
    sprinkle(b, hh, city, "shopping", [("walmartshop", 3), ("dollartree", 3), ("amazon", 2), ("target", 1)], 1.3, 26, 0.7, 4, 120, [(chk, .8), (card, .2)])
    sprinkle(b, hh, city, "health", [("walgreens", 2), ("cvs", 1)], 0.5, 19, 0.6, 4, 80, [(chk, 1)])
    # --- anomalies: a messy bank import
    mark_duplicates(b, chk, 7, next_day_prob=0.45)
    mark_duplicates(b, card, 1, min_amt=5)
    mark_garbled(b, chk, 9, modes=["moji", "symbols", "symbols"])
    b.tx(chk, D(2026, 8, 22), -9999999.99, "Starbucks", "dining", "PURCHASE AUTHORIZED ON 08/22 STARBUCKS STORE 11873 ARLINGTON TX", False, anomaly="impossible_value")
    b.tx(chk, D(2026, 12, 5), -1285.00, "Oakview Apartments", "rent", "ONLINE PMT OAKVIEW APARTMENTS RENT", False, anomaly="impossible_value")
    b.tx(chk, D(2027, 1, 3), 284.50, "DoorDash", "income", "DOORDASH, INC. PAYMENT 855-555-0166", False, anomaly="impossible_value")
    b.tx(chk, D(2026, 9, 3), -1146.37, "Firestone Complete Auto Care", "auto", "PURCHASE AUTHORIZED ON 09/03 FIRESTONE COMPLETE AUTO CARE ARLINGTON TX", False, anomaly="outlier")

    card_payments(b, card, chk, 22, "Cedar Springs Card Services", "revolve", owed0=1010.0, target_final=1120.0, min_pay=40.0, ob_name="Secured card payment")
    interest_credits(b, sav, 0.50, 210)
    transfer_monthly(b, chk, sav, 28, 10.0, "ONLINE TRANSFER TO STARTER SAVINGS", "TRANSFER FROM CHECKING", "savings")


# ======================================================================= BROOKS
def build_brooks(b: Book):
    hh, city, rng = "hh_brooks", "DeSoto", b.rng
    chk, sav, f529, ira = "acct_brooks_chk", "acct_brooks_sav", "acct_brooks_529", "acct_brooks_ira"
    mtg, auto, card = "acct_brooks_mtg", "acct_brooks_auto", "acct_brooks_card"
    T, Dn, J, W = "mem_brooks_terrence", "mem_brooks_danielle", "mem_brooks_jordan", "mem_brooks_walter"
    b.acct(chk, hh, [T, Dn, W], "checking", "Keystone Bank", "Family Checking", 3880.00, "2012-10-03", rate_pct=0.01)
    b.acct(sav, hh, [T, Dn], "savings", "Keystone Bank", "Emergency Fund", 11800.00, "2015-04-22", rate_pct=4.10)
    b.acct(f529, hh, [T, Dn], "savings", "Lone Star 529 Plan", "Jordan's 529 College Savings", 27400.00, "2011-08-01", rate_pct=4.50)
    b.acct(ira, hh, [Dn], "ira", "Summit Retirement Services", "Danielle's Rollover IRA", 64200.00, "2014-07-15")
    b.acct(mtg, hh, [T, Dn], "mortgage", "Trinity Federal", "Home Mortgage", 198400.00, "2021-04-30", rate_pct=3.375,
           monthly_payment=2386.15, maturity_date="2051-05-01")
    b.acct(auto, hh, [T], "auto_loan", "Lone Star Credit Union", "Terrence's SUV Loan", 22900.00, "2024-02-10", rate_pct=6.40,
           monthly_payment=498.00, maturity_date="2030-02-10")
    b.acct(card, hh, [T, Dn], "credit_card", "Gulf & Plains Bank", "Cash Visa", 0, "2013-01-18", rate_pct=20.49,
           credit_limit=12000, monthly_payment=35)

    _income(b, chk, every(D(2026, 11, 6)), 2481.55, "Trinity Freight Logistics",
            "DIRECT DEP TRINITY FREIGHT LOGISTICS PAYROLL PPD ID: 1472265")
    _income(b, chk, monthly_dates(15) + [d for d in (clip_day(y, m, 31) for y, m in window_months()) if WIN_START <= d <= WIN_END],
            2012.40, "DeSoto ISD", "DIRECT DEP DESOTO ISD PAYROLL PPD ID: 1750338")
    _income(b, chk, every(D(2026, 10, 29)), 164.20, "Zaxby's", "DIRECT DEP ZAXBYS DESOTO PAYROLL PPD ID: 1620912")
    monthly(b, chk, 3, 2050.00, "Social Security Administration", "SSA TREAS 310 XXSOC SEC", "income")
    monthly(b, chk, 12, -265.00, "Lone Star Mutual Insurance", "LONE STAR MUTUAL AUTO+HOME", "insurance", ob=("Auto + home insurance", "insurance"))
    monthly(b, chk, 14, -245.00, "Reliant Energy", "RELIANT ENERGY RETAIL", "utilities", jitter=0.08, season=SEASON_ELEC, ob=("Reliant electric", "bill"))
    monthly(b, chk, 21, -66.00, "Atmos Energy", "ATMOS ENERGY WEB PMT", "utilities", jitter=0.1, season=SEASON_GAS, ob=("Atmos Energy gas", "bill"))
    monthly(b, chk, 10, -110.00, "City of DeSoto Water", "CITY OF DESOTO UTILITY BILLING", "utilities", jitter=0.1, ob=("City of DeSoto water", "bill"))
    monthly(b, chk, 7, -120.00, "Xfinity", "COMCAST XFINITY 800-555-0135", "utilities", ob=("Xfinity internet", "bill"))
    monthly(b, chk, 18, -212.00, "T-Mobile", "TMOBILE*AUTO PAY", "utilities", ob=("T-Mobile (4 lines)", "bill"))
    monthly(b, chk, 5, -320.00, "Comfort Care Home Services", "COMFORT CARE HOME SERVICES AIDE", "health", ob=("Walter's home aide (start of month)", "bill"))
    monthly(b, chk, 19, -320.00, "Comfort Care Home Services", "COMFORT CARE HOME SERVICES AIDE", "health", ob=("Walter's home aide (mid-month)", "bill"))
    monthly(b, chk, 20, -15.49, "Netflix", "NETFLIX.COM", "subscriptions", ob=("Netflix", "subscription"))
    monthly(b, chk, 6, -11.99, "Spotify", "SPOTIFY USA", "subscriptions", ob=("Spotify", "subscription"))
    loan_payment(b, mtg, chk, 1, 2386.15, "Trinity Federal", "TRINITY FEDERAL MTG PMT {d:%m/%d}", "mortgage", "Mortgage (Trinity Federal)")
    loan_payment(b, auto, chk, 8, 498.00, "Lone Star Credit Union", "LONE STAR CU AUTO LOAN PMT {d:%m/%d}", "loan_payment", "SUV auto loan")
    transfer_monthly(b, chk, f529, 4, 450.0, "ONLINE TRANSFER TO 529 PLAN", "CONTRIBUTION - FAMILY CHECKING", "savings", ("529 plan contribution", "bill"))
    transfer_monthly(b, chk, ira, 11, 200.0, "SUMMIT RETIREMENT IRA CONTRIBUTION", "CONTRIBUTION - EMPLOYEE", "savings")
    b.tx(chk, D(2026, 7, 8), -345.00, "Texas Teen Drive School", "education", "TEXAS TEEN DRIVE SCHOOL DESOTO", False)
    b.tx(chk, D(2026, 8, 12), -175.00, "DeSoto High School Athletics", "education", "DESOTO HS ATHLETICS FEE", False)
    b.tx(chk, D(2026, 9, 11), -2860.00, "Alamo Roofing & Restoration", "home_repair", "ALAMO ROOFING & RESTORATION STORM LEAK REPAIR", False, anomaly="outlier")

    kw = dict(dow=WEEKEND)
    sprinkle(b, hh, city, "groceries", [("kroger", 3), ("walmart", 3), ("heb", 2), ("aldi", 1), ("samsclub", 1)], 3.6, 92, 0.5, 10, 300, [(chk, .55), (card, .45)], **kw)
    sprinkle(b, hh, city, "dining", [("chickfila", 3), ("canes", 3), ("whataburger", 2), ("chipotle", 2), ("starbucks", 2), ("sonic", 1)], 3.8, 31, 0.55, 5, 120, [(card, .7), (chk, .3)], **kw)
    sprinkle(b, hh, city, "fuel", [("qt", 3), ("shell", 2), ("exxon", 2), ("racetrac", 1)], 2.3, 49, 0.3, 22, 85, [(card, .8), (chk, .2)])
    sprinkle(b, hh, city, "shopping", [("amazon", 4), ("target", 3), ("walmartshop", 2), ("homedepot", 2), ("lowes", 1), ("kohls", 1), ("ross", 1)], 3.0, 40, 0.85, 5, 330, [(card, .5), (chk, .5)])
    sprinkle(b, hh, city, "kids", [("dicks", 2), ("fivebelow", 1), ("oldnavy", 2), ("bestbuy", 1)], 0.8, 46, 0.6, 8, 220, [(card, .8), (chk, .2)])
    sprinkle(b, hh, city, "health", [("cvs", 2), ("walgreens", 2)], 1.2, 34, 0.7, 4, 160, [(chk, 1)])
    sprinkle(b, hh, city, "entertainment", [("amc", 2), ("topgolf", 1), ("sixflags", 1)], 0.35, 70, 0.6, 18, 260, [(card, .8), (chk, .2)], dow=WEEKEND)
    b.tx(card, D(2026, 7, 16), -2186.40, "Hilton Garden Inn / Southwest", "travel", "SOUTHWEST AIRLINES 5262 + HILTON GARDEN INN ORLANDO FL", False)
    b.tx(card, D(2026, 8, 29), -412.00, "Texas Rangers Tickets", "entertainment", "RANGERS BALLPARK TICKETS ARLINGTON TX", False)
    b.tx(chk, D(2026, 6, 6), -640.00, "Jordan's Braces Co-pay", "health", "DESOTO FAMILY ORTHODONTICS", False)
    mark_duplicates(b, chk, 1, min_amt=10, max_amt=120, next_day_prob=0.0)
    card_payments(b, card, chk, 22, "Gulf & Plains Bank", "full", ob_name="Cash Visa payment")
    interest_credits(b, sav, 4.10, 11500)
    interest_credits(b, f529, 4.50, 27000)
    sweeps(b, chk, sav, 4600.0, 4600.0, 3880.0, frac=0.6)
    b.accts[chk]["_s0"] = 4600.0


# ======================================================================= assemble
def _patel_sim(b: Book, chk: str, s0: float, apply: bool, fee=35.0, cushion=25.0, max_cures=6):
    """Walk Patel's checking day by day. She skips discretionary purchases when the balance is nearly empty,
    fixed bills still hit (that is where overdraft fees come from), and when she is badly overdrawn her sister
    Neha sends a little help."""
    disc = {"groceries", "dining", "fuel", "shopping", "health"}
    rows = sorted(b.rows_for(chk), key=lambda r: (r["date"], r["seq"]))
    bal, fee_days, drop, fees, cures = s0, set(), [], [], []
    for r in rows:
        if (r["category"] in disc and r["anomaly"] is None and not r["is_recurring"] and r["amount"] < 0
                and bal + r["amount"] < cushion):
            drop.append(r)
            continue
        bal += r["amount"]
        if bal < 0 and r["amount"] < 0 and r["date"] not in fee_days and r["category"] != "fees":
            fee_days.add(r["date"])
            fees.append(r["date"])
            bal -= fee
        if bal < -100 and len(cures) < max_cures and (not cures or cures[-1][0] != r["date"]):
            amt = float(min(300, -(-int(150 - bal) // 25) * 25))
            cures.append((r["date"], amt))
            bal += amt
    if apply:
        ids = {id(r) for r in drop}
        b.rows = [r for r in b.rows if id(r) not in ids and r["tag"] != "fee"]
        for d in fees:
            b.tx(chk, d, -fee, "Overdraft Fee", "fees", "OVERDRAFT FEE - ITEM PAID", False, tag="fee")
        for d, amt in cures:
            b.tx(chk, d, amt, "Zelle - Neha Shah", "transfer", "ZELLE FROM NEHA SHAH - FAMILY HELP", False)
    return bal, len(fees), len(cures)


def settle_patel(b: Book):
    """Pick Patel's opening balance and scale her gig income (bisection) so that she closes near the target
    cushion with a handful of overdraft fees, not a snowball of them."""
    chk = "acct_patel_chk"
    target = b.accts[chk]["_target"]
    base = [(r, r["amount"]) for r in b.rows if r["account_id"] == chk and r["merchant"] in ("DoorDash", "Uber", "Instacart")
            and r["amount"] > 0 and r["anomaly"] is None]

    def run(s0, f):
        for r, a in base:
            r["amount"] = round(a * f, 2)
        return _patel_sim(b, chk, s0, apply=False)

    best = None
    for s0 in (300.0, 450.0, 600.0, 750.0, 900.0, 1100.0):
        lo, hi = 0.6, 1.8
        for _ in range(14):
            mid = (lo + hi) / 2
            final, _nf, _nc = run(s0, mid)
            lo, hi = (mid, hi) if final < target else (lo, mid)
        final, nf, nc = run(s0, hi)
        score = abs(final - target) / 50 + max(0, nf - 12) + max(0, 4 - nf) + 2 * max(0, nc - 5)
        if best is None or score < best[0]:
            best = (score, s0, hi)
        if score < 1.2:
            break
    _score, s0, f = best
    run(s0, f)
    _patel_sim(b, chk, s0, apply=True)
    b.accts[chk]["_s0"] = s0


def finalize(b: Book):
    """Set balances so that the books reconcile; returns warnings."""
    warns = []
    for a in b.accts.values():
        t, aid = a["type"], a["id"]
        if t == "checking":
            s0 = a["_s0"]
            a["balance"] = round(s0 + b.total(aid), 2)
            lo = running_min(b, aid, s0)
            if lo < 0 and a["household_id"] != "hh_patel":
                warns.append(f"{aid}: running balance dips to {lo}")
        elif t in ("savings", "cd", "ira"):
            s0 = a["_target"] - b.total(aid)
            if s0 < 50:
                s0 = 50.0
            a["_s0"] = round(s0, 2)
            a["balance"] = round(s0 + b.total(aid), 2)
        elif t == "credit_card":
            owed = a.get("_owed0", 0.0) - b.total(aid)
            a["balance"] = round(owed, 2)
            if not 0 <= owed <= a["credit_limit"]:
                warns.append(f"{aid}: owed {owed} outside [0, limit]")
        # loans keep their given balance
    return warns


def build_all(rng):
    b = Book(rng)
    build_rivera(b)
    build_okafor(b)
    build_nguyen(b)
    build_patel(b)
    settle_patel(b)
    build_brooks(b)
    warns = finalize(b)
    return b, warns


def to_records(b: Book):
    order = {h[0]: i for i, h in enumerate(HOUSEHOLDS)}
    rows = sorted(b.rows, key=lambda r: (order[b.hh_of(r["account_id"])], r["date"], r["account_id"], r["seq"]))
    txns = []
    for i, r in enumerate(rows, 1):
        rec = dict(id=f"txn_{i:06d}", household_id=b.hh_of(r["account_id"]), account_id=r["account_id"], date=r["date"].isoformat(),
                   amount=r["amount"], merchant=r["merchant"], category=r["category"], description=r["description"],
                   is_recurring=r["is_recurring"])
        if r["anomaly"]:
            rec["anomaly"] = r["anomaly"]
        txns.append(rec)
    accounts = []
    for a in b.accts.values():
        accounts.append({k: v for k, v in a.items() if not k.startswith("_")})
    accounts.sort(key=lambda a: (order[a["household_id"]],))
    # credit profiles with utilization computed from the card accounts
    credit = []
    for mid, (score, inq, oldest, late) in CREDIT.items():
        cards = [a for a in b.accts.values() if a["type"] == "credit_card" and mid in a["owner_member_ids"]]
        lim = sum(a["credit_limit"] for a in cards)
        owed = sum(a["balance"] for a in cards)
        util = round(100 * owed / lim, 1) if lim else 0.0
        hh = next(m[1] for m in MEMBERS if m[0] == mid)
        credit.append(dict(member_id=mid, household_id=hh, score=score, utilization_pct=util, hard_inquiries_12m=inq,
                           oldest_account_years=oldest, late_payments_24m=late))
    hhs = [dict(id=i, name=n, city=c, state="TX", persona=PERSONAS[i], home_value=hv, vehicle_value=vv)
           for i, n, c, hv, vv in HOUSEHOLDS]
    members = [dict(id=m[0], household_id=m[1], name=m[2], age=m[3], role=m[4], income_annual=m[5]) for m in MEMBERS]
    obligations = sorted(b.obl, key=lambda o: (order[o["household_id"]], o["id"]))
    return dict(households=hhs, members=members, accounts=accounts, transactions=txns, credit_profiles=credit,
                obligations=obligations)
