"""Sample Huddle transcripts (6) with the goals an extractor should find.

Every `evidence_quote` must be a verbatim substring of one of the conversation's turns; generate.py asserts this.
Numbers in the Patel transcript that depend on generated data are filled from `facts`.
"""
from __future__ import annotations

WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
         "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]


_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
         "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def say_dollars(n: int) -> str:
    """Spoken amount for 0 < n < 1000, e.g. 164 -> 'a hundred sixty-four'."""
    parts = []
    if n >= 100:
        parts.append("a hundred" if n // 100 == 1 else f"{_ONES[n // 100]} hundred")
        n %= 100
    if n >= 20:
        parts.append(_TENS[n // 10] + (f"-{_ONES[n % 10]}" if n % 10 else ""))
    elif n:
        parts.append(_ONES[n])
    return " ".join(parts)


def _goal(cid_hh, slug, title, priority, source="huddle", amount=None, date=None, feas=None, quote=None):
    g = {"id": f"goal_{slug}", "household_id": cid_hh, "title": title}
    if amount is not None:
        g["target_amount"] = amount
    if date is not None:
        g["target_date"] = date
    g["priority"] = priority
    if feas:
        g["feasibility"] = feas
    if quote:
        g["evidence_quote"] = quote
    g["source"] = source
    return g


def _turns(pairs):
    return [{"speaker": s, "text": t} for s, t in pairs]


def build_conversations(facts: dict) -> list[dict]:
    od_n = int(facts.get("patel_overdraft_count", 4))
    od_total = int(round(facts.get("patel_overdraft_total", 35 * od_n)))
    od_word = WORDS[od_n] if od_n < len(WORDS) else str(od_n)
    bal_words = say_dollars(int(facts.get("patel_balance", 164)))
    convs = []

    # ------------------------------------------------------------------ Rivera 1
    h = "hh_rivera"
    convs.append({
        "id": "conv_rivera_01", "household_id": h,
        "title": "A second bakery on Gaston Avenue (and the SBA idea)",
        "turns": _turns([
            ("Marisol", "Okay, so, um, the landlord on Gaston Avenue called me back. The old dry cleaner space, the one by the Lakewood Theater? He'll hold it until December first, but not a day longer."),
            ("Daniel", "December first. That's, what, three and a half weeks? Marisol, we haven't even priced the build-out."),
            ("Marisol", "I did price it. The contractor came Tuesday. Ovens, the hood, the walk-in cooler, the front counter, the whole thing. He said about two hundred fifty thousand for the build-out. That's with a little cushion."),
            ("Daniel", "Two fifty. Okay. And we'd put that on... what, exactly? We don't have that just sitting in the bank."),
            ("Marisol", "No, no. That's why I called Rosa's lender, the SBA guy. The seven-a loan. Ten years, and with the bakery's numbers he thinks we'd probably qualify. We put ten percent down, maybe twenty-five thousand."),
            ("Daniel", "Twenty-five thousand. Which is most of the emergency fund."),
            ("Marisol", "Most of it, yes, I know, that's what I'm— wait, let me finish. We have fourteen thousand in the emergency fund, and October through December is our best quarter. Día de Muertos, the tamale orders, Christmas."),
            ("Daniel", "Best quarter, but also the lumpy one, mi amor. Remember last January? Flour, the lease, the estimated taxes all went out in one week and your draw was tiny."),
            ("Sofia", "Can I say something? Mom, are you gonna work even more? You're already at the shop at four in the morning."),
            ("Marisol", "Mija, that's fair. That's, okay, that's really fair. The idea is Lupe runs the new place. She's been with us six years. So it's not me at two ovens at once."),
            ("Mateo", "Is there gonna be pan de muerto at the new one? Do I get a free concha?"),
            ("Daniel", "Mateo, buddy, this is adult talk. We'll discuss concha policy later."),
            ("Mateo", "That's not a no."),
            ("Marisol", "It's not a no. Okay, Daniel, honestly, what's your gut?"),
            ("Daniel", "My gut is I love it and I'm scared. Um. If the second place takes, like, eight months to break even, can we still cover the mortgage and Sofia's volleyball and the truck payment? Because my paycheck covers the mortgage and not much else."),
            ("Marisol", "That's what I want to run through. The bakery did about one point three million last year. If the new store does even half of that by year two--"),
            ("Daniel", "Even half. And if it does a third?"),
            ("Marisol", "Then we're tight for a year. I'm not saying it's risk free."),
            ("Daniel", "Okay. And how long does the SBA thing take? Because December first is soon."),
            ("Marisol", "He said six to eight weeks once the paperwork is in. So we ask the landlord for a lease that starts in March, rent kicks in after the build-out, and we open by the end of September next year."),
            ("Daniel", "Fine. Let's do it properly. Let's find out what we'd actually be approved for and what the payment would be, then decide. I don't want to guess."),
            ("Marisol", "Deal. And a plan for the lumpy months. Like a bakery reserve so a slow February doesn't land on our personal checking."),
            ("Sofia", "Dad said deal so it's official."),
            ("Daniel", "I said let's find out. Different."),
        ]),
        "expected_goals": [
            _goal(h, "rivera_second_location", "Open a second bakery location on Gaston Avenue", "high", amount=250000,
                  date="2027-09-30", feas="stretch", quote="about two hundred fifty thousand for the build-out"),
            _goal(h, "rivera_sba_prequal", "Get SBA 7(a) pre-qualified before the landlord's Dec 1 deadline", "high",
                  amount=250000, date="2026-12-01", feas="on_track", quote="find out what we'd actually be approved for"),
            _goal(h, "rivera_bakery_reserve", "Build a cash reserve for the bakery's slow months", "medium", feas="stretch",
                  quote="a plan for the lumpy months"),
        ],
    })

    # ------------------------------------------------------------------ Rivera 2
    convs.append({
        "id": "conv_rivera_02", "household_id": h,
        "title": "Abuela's care and Sofia's college fund",
        "turns": _turns([
            ("Marisol", "Mamá, sit, sit. We want to talk about the doctor stuff, and we want you in the room for it, not hearing about it later."),
            ("Elena", "Ay, Marisol, I don't want to be a burden. I can pay for my own pills."),
            ("Daniel", "Elena, nobody said burden. Nobody. We just want to look at the real numbers together."),
            ("Marisol", "So, the hospital bill in September was three thousand four hundred and twelve dollars. That was after the supplement paid. And the cardiologist copays, the pharmacy, it's adding up."),
            ("Daniel", "I added it up last night. Pharmacy, the heart doctor, the aide you wanted for the mornings... it's about seven hundred eighty a month. That's roughly nine thousand a year, if nothing new happens."),
            ("Elena", "Nine thousand! Dios mío. That's too much. I could use less help. I don't need somebody every day."),
            ("Marisol", "Mamá, you fell in the kitchen in August. The aide stays, at least three mornings a week."),
            ("Elena", "Okay, okay. Three mornings. But my Social Security, I want to put something in. Not nothing."),
            ("Daniel", "You already put in. Your check pays for half the groceries. Let us handle the medical for the year. I'd say let's set aside nine thousand and stop worrying about it every month."),
            ("Marisol", "And Medicare open enrollment closes December seventh. I want to compare plans before then, there's one with a lower out-of-pocket max."),
            ("Daniel", "Good. Put that on the list, with a date."),
            ("Sofia", "Can I ask a question? Is this going to, like, take money from college? Because Ms. Alvarez said I should start looking at applications in two years."),
            ("Marisol", "No, mija, we're not taking from your college fund. We're just being honest that everything has a cost."),
            ("Sofia", "I want to study nursing, maybe. At UT Dallas or A&M. Abuela's doctors are kind of why."),
            ("Elena", "Ay, mi niña. See? I told you, she has my heart. The good part, not the broken part."),
            ("Daniel", "Ha. Okay. So the college fund. We've got twenty-one thousand five hundred in there for you and Mateo. We put in five hundred a month."),
            ("Marisol", "Four years in state is, what, a hundred thousand with everything? Housing, books, all of it?"),
            ("Daniel", "About that. If we want sixty thousand saved by the time Sofia starts, which is August of twenty twenty-nine, we need to put in more than five hundred. Closer to eight hundred a month."),
            ("Marisol", "Eight hundred is a lot with the bakery being up and down."),
            ("Daniel", "It is. Maybe five hundred now and a lump in the busy season when the draws are fat. Every holiday quarter, we throw some in."),
            ("Sofia", "I can work at the bakery on Saturdays and put that in too. Real wages. Mom, you owe me minimum wage."),
            ("Marisol", "Minimum wage, I'll think about it. Okay. Sixty thousand by August of twenty twenty-nine, and nine thousand set aside for Abuela."),
        ]),
        "expected_goals": [
            _goal(h, "rivera_elena_care", "Set aside funds for Elena's medical and home-care costs", "high", amount=9000,
                  date="2027-11-07", feas="on_track", quote="let's set aside nine thousand"),
            _goal(h, "rivera_medicare_enrollment", "Compare Medicare plans for Elena before open enrollment ends Dec 7", "medium",
                  date="2026-12-07", feas="on_track", quote="Medicare open enrollment closes December seventh"),
            _goal(h, "rivera_college_fund", "Grow the college fund to $60,000 by Sofia's freshman year", "medium", amount=60000,
                  date="2029-08-15", feas="stretch", quote="sixty thousand saved by the time Sofia starts"),
        ],
    })

    # ------------------------------------------------------------------ Okafor
    h = "hh_okafor"
    convs.append({
        "id": "conv_okafor_01", "household_id": h,
        "title": "Buying our first home in two years",
        "turns": _turns([
            ("Amara", "Okay, so, I ran the numbers on that listing site again. If we want a place around three hundred forty thousand, in like, Garland or Mesquite or Lake Highlands..."),
            ("Chidi", "Lake Highlands is not three-forty, babe. Lake Highlands is four-fifty for a shoebox."),
            ("Amara", "Fine, Mesquite or Richardson. The point is, three-forty, five percent down is seventeen thousand, plus closing costs, call it, um, thirty thousand total to be safe."),
            ("Chidi", "Thirty thousand. We have, what, twenty-two in the House Fund right now?"),
            ("Amara", "Twenty-two three. Which would've been twenty-seven if that weird transfer in September hadn't happened."),
            ("Chidi", "Don't. I'm still mad. The bank says they're still investigating, maybe a provisional credit by Thanksgiving."),
            ("Amara", "Okay. Okay. But even with that, we put in six hundred a month, so, what, another year and we hit thirty. That's the easy part."),
            ("Chidi", "Right, so what's the hard part?"),
            ("Amara", "The cards. The loan officer told me, like, bluntly, with our utilization we'd get a worse rate and maybe not even get approved. Mine's at like eighty-six percent."),
            ("Chidi", "Eighty-six. Ugh. Mine's the store card, that's sixty-one. And that stupid Southwest flight is still on yours."),
            ("Amara", "It's the flight and the dining and, honestly, DoorDash. Don't look at me like that, you ordered half of it."),
            ("Chidi", "I ordered... okay, I ordered half of it."),
            ("Amara", "So the plan is, we get both cards under thirty percent before we apply. That's about, um, sixty-eight hundred we'd have to pay down."),
            ("Chidi", "Sixty-eight hundred. While also saving six hundred a month. On top of two student loans, the Civic, rent at seventeen twenty-five..."),
            ("Amara", "I know. It's a stretch. But if we cut the Peloton and the DoorDash habit, that's like three hundred a month right there."),
            ("Chidi", "The Peloton is the only thing keeping me alive."),
            ("Amara", "Crunch is twenty-five dollars, Chidi."),
            ("Chidi", "Fine. Fine. Cancel the Peloton. What about an emergency fund? If we put everything into the house and then the AC dies in our new place..."),
            ("Amara", "Good point. Three months of bare-bones expenses is, um, like fifteen thousand. That's separate from the House Fund."),
            ("Chidi", "Fifteen. So really we're saving forty-five total. In two years. On two incomes. Okay. That sounds scary when you say it out loud."),
            ("Amara", "It's scary but it's also one number at a time. Cards first, then the House Fund, then the emergency fund. Our lease is up in October of twenty twenty-eight, so that's the target."),
            ("Chidi", "Okay. October twenty twenty-eight. Write it on the fridge."),
        ]),
        "expected_goals": [
            _goal(h, "okafor_first_home", "Buy a first home by October 2028", "high", amount=30000, date="2028-10-31",
                  feas="stretch", quote="thirty thousand total to be safe"),
            _goal(h, "okafor_card_paydown", "Get both credit cards under 30% utilization before applying for a mortgage", "high",
                  amount=6800, date="2028-04-30", feas="stretch", quote="we get both cards under thirty percent before we apply"),
            _goal(h, "okafor_emergency_fund", "Build a three-month emergency fund", "medium", amount=15000, date="2028-10-31",
                  feas="off_track", quote="Three months of bare-bones expenses"),
        ],
    })

    # ------------------------------------------------------------------ Nguyen
    h = "hh_nguyen"
    convs.append({
        "id": "conv_nguyen_01", "household_id": h,
        "title": "The phone call about Kevin",
        "turns": _turns([
            ("Mai", "Okay, Ba, Má, start from the beginning. Slowly. What time did the phone ring?"),
            ("Tom", "Um, about noon. Maybe twelve-thirty? Wednesday. The phone said Houston, so I thought maybe it was Kevin's school."),
            ("Linh", "A man said, Grandma? It's me. Very quiet, crying a little. I said Kevin? And he said yes."),
            ("Mai", "Má, you said his name first. Okay, keep going."),
            ("Tom", "Then another man took the phone. He said he was Attorney Mark Whitfield. Kevin had a car accident, the police found something in the car, and Kevin was in the county jail."),
            ("Linh", "He said bail was two thousand dollars, and it had to be today, or Kevin would stay in jail over the weekend."),
            ("Tom", "And he said do not tell Kevin's mom and dad, because Kevin was embarrassed and the case could be sealed if we paid fast."),
            ("Mai", "And you paid how?"),
            ("Linh", "He said the court takes gift cards because the computer system was down. So I went to CVS, and then Walgreens. Tom took the car to Target and Kroger."),
            ("Tom", "Five hundred each, four stores. The man stayed on the phone with me the whole time. He told me which cards, Apple and Google Play and Target, and to read him the numbers on the back."),
            ("Mai", "The whole time? Ba, did the cashier say anything?"),
            ("Linh", "The girl at Walgreens asked if it was a gift. The man said say yes. I said yes."),
            ("Tom", "Then he called again Thursday. He said Kevin needed three thousand five hundred more for court fees. That's when Linh said wait."),
            ("Linh", "I said, I want to talk to Kevin. He said no, Kevin has no phone. I hung up. My hands were shaking."),
            ("Mai", "I'm so glad you hung up. I called Kevin an hour ago. He's at work in Houston. He's fine. He's never been arrested."),
            ("Tom", "Two thousand dollars."),
            ("Mai", "I know. Ba, it's not your fault. These people are professionals. They find the grandchildren's names online."),
            ("Linh", "And then somebody called who said IRS. Saying we owe back taxes and there is a warrant. That time I knew. I knew."),
            ("Mai", "Okay. Here's what we do. Tomorrow we go to the bank branch and report the debit card purchases. We call the gift card companies with the numbers, sometimes they can freeze unspent cards. We file a police report and one with the FTC. And we put alerts on all your accounts."),
            ("Tom", "And a rule for the house. Any call about money, we hang up and call the family back on the number we already know."),
            ("Linh", "A code word. With Kevin. Something only family knows."),
            ("Mai", "Yes. Also, Ba, the six-month CD at the bank, it matures December fifth. We should decide before then what to do with it. Don't let anyone talk you into moving it."),
        ]),
        "expected_goals": [
            _goal(h, "nguyen_scam_report", "Report the $2,000 gift-card scam and try to recover the money", "high", amount=2000,
                  date="2026-11-13", feas="on_track", quote="report the debit card purchases"),
            _goal(h, "nguyen_scam_shield", "Turn on scam alerts and a call-back rule for every account", "high",
                  date="2026-11-30", feas="on_track", quote="we put alerts on all your accounts"),
            _goal(h, "nguyen_cd_decision", "Decide what to do with the 6-month CD maturing Dec 5", "medium", amount=25000,
                  date="2026-12-05", feas="on_track", quote="it matures December fifth"),
        ],
        "scam_signals": [
            "Caller posed as a grandchild in jail and begged them not to tell his parents",
            "Second caller posed as an attorney and set a same-day deadline for $2,000 bail",
            "Payment demanded in gift cards (Apple, Google Play, Target) with card numbers read out over the phone",
            "Caller stayed on the line during the purchases and coached the answer to the cashier",
            "Four $500 gift-card purchases at four stores within about two hours (13:04 to 15:02 on Oct 21)",
            "Follow-up call the next day demanded $3,500 more for 'court fees'",
            "Caller refused to let them speak to the grandson directly",
            "A separate call impersonating the IRS threatened a warrant over back taxes",
        ],
    })

    # ------------------------------------------------------------------ Patel
    h = "hh_patel"
    convs.append({
        "id": "conv_patel_01", "household_id": h,
        "title": "Making it to Friday",
        "turns": _turns([
            ("Priya", "Okay, Neha, I'm putting you on speaker, I'm just doing the math in the car real quick. Aarav, seatbelt."),
            ("Neha", "Go. What's the damage?"),
            ("Priya", f"So. Bank app says {bal_words} dollars. The installment loan comes out Tuesday, that's one forty-two. Insurance is Friday morning, one forty-eight. And my paycheck is not until Friday the thirteenth. It posts in the afternoon, of course."),
            ("Neha", "So wait, you're short? Before Friday?"),
            ("Priya", "Not short short. Tuesday is the DoorDash payout, it's usually like two hundred. But if it's a slow week, um, it's like ninety, and then something bounces and they hit me with the thirty-five dollar overdraft fee. Again."),
            ("Neha", "Again? How many times since the summer?"),
            ("Priya", f"I counted. {od_word.capitalize()}. {od_word.capitalize()} times since May. That's {od_total} dollars gone, that's most of a car payment."),
            ("Aarav", "Mom, can I get the thing from the machine? The claw machine?"),
            ("Priya", "Not today, baby. Mommy's counting. Sit tight."),
            ("Aarav", "You're always counting."),
            ("Neha", "Priya, let me send you something. A hundred."),
            ("Priya", "No, no. I'm not-- okay. Honestly? Just for the rent thing. I was late in October and they charged seventy-five."),
            ("Neha", "Take it. Pay me back whenever. But you need a cushion. Like, anything. Five hundred dollars that's just there."),
            ("Priya", "A five hundred dollar cushion. By January. I would cry. Okay. Every payout, I take fifteen percent and don't touch it. DoorDash, Uber, Instacart. Fifteen percent goes in the savings account."),
            ("Neha", "And the bank app thing, with the weird charges, the garbled ones?"),
            ("Priya", "Yeah, the import is a mess. There's a coffee that says ten million dollars. I'm not even kidding. I need to get that sorted before I ever try to get a better loan."),
        ]),
        "expected_goals": [
            _goal(h, "patel_next_paycheck", "Make it to Friday's paycheck without an overdraft", "high", amount=150,
                  date="2026-11-13", feas="stretch", quote="my paycheck is not until Friday the thirteenth"),
            _goal(h, "patel_starter_cushion", "Build a $500 starter emergency cushion", "medium", amount=500, date="2027-01-31",
                  feas="stretch", quote="A five hundred dollar cushion"),
            _goal(h, "patel_gig_savings_rule", "Save 15% of every gig payout", "medium", feas="on_track",
                  quote="Every payout, I take fifteen percent and don't touch it"),
        ],
    })

    # ------------------------------------------------------------------ Brooks
    h = "hh_brooks"
    convs.append({
        "id": "conv_brooks_01", "household_id": h,
        "title": "The roof, Pop's care, and Jordan's college money",
        "turns": _turns([
            ("Danielle", "Okay, family meeting. Jordan, phone down. Terrence, you too. Pop, do you want your tea before we start?"),
            ("Walter", "I'm fine, Danielle. Go ahead. I'll just listen and pretend I'm not eavesdropping."),
            ("Terrence", "So, three things. The roof, the aide for Pop, and Jordan's college money. And I want us to talk about it as one budget, not three arguments."),
            ("Danielle", "Roof first, since it leaked again. The guy said patching the section over the garage is a Band-Aid. A full replacement is, um, fourteen thousand five hundred."),
            ("Terrence", "We did the storm repair in September for twenty-eight sixty. That was supposed to hold."),
            ("Danielle", "It held for six weeks. He says get it done before spring storm season, April at the latest."),
            ("Jordan", "Can I say something about the car thing?"),
            ("Terrence", "Jordan, we haven't even gotten to the car thing."),
            ("Jordan", "I'm just saying, I'll be seventeen in March, I have like twenty-one hundred saved from Zaxby's, and I'm on the schedule for thirty hours over Christmas."),
            ("Danielle", "Baby, we'll get there. College first."),
            ("Terrence", "Okay. The 529. We have twenty-seven four in there and we put in four-fifty a month. Jordan starts fall of twenty twenty-eight. To cover about sixty thousand, we're, um, twenty-some thousand short."),
            ("Danielle", "Twenty-some thousand. On top of the roof."),
            ("Walter", "Can I put my two cents in, since I'm apparently a line item?"),
            ("Terrence", "Pop, you're not a line item."),
            ("Walter", "I am, and that's fine. The aide is six forty a month. I'd rather that money went to Jordan's school than me sitting around with company. Cut it to once a week."),
            ("Danielle", "Absolutely not. You fell in June. The aide stays."),
            ("Walter", "Then at least let me put an extra two hundred a month toward the college thing out of my Social Security."),
            ("Terrence", "...Okay. Okay, Pop. Thank you. That helps."),
            ("Danielle", "So I think the roof comes first, because water in the house costs more than anything. Our mortgage is three point four, so I'm not touching that with a refinance."),
            ("Terrence", "No refinance. The emergency fund has eleven eight, a roof at fourteen five would take all of it and then some. I'd rather save over five months, about three thousand a month, and get the roof on in April."),
            ("Danielle", "Three thousand a month. Tight, but the raise kicks in January."),
            ("Jordan", "What if I just drive the old Corolla? I don't need a new car. I need, like, a car."),
            ("Walter", "That Corolla is in the shop more than on the road. Eight thousand five hundred gets you something decent with low miles."),
            ("Terrence", "Jordan, I'll match whatever you save, up to four thousand. The rest we revisit in June."),
            ("Jordan", "Deal. Wait, really? Deal."),
            ("Danielle", "Write it down: roof by April, the 529 gets Pop's two hundred plus our four-fifty, and Jordan's car by June."),
        ]),
        "expected_goals": [
            _goal(h, "brooks_roof", "Replace the roof before spring storm season", "high", amount=14500, date="2027-04-15",
                  feas="stretch", quote="A full replacement is, um, fourteen thousand five hundred"),
            _goal(h, "brooks_529", "Close the gap on Jordan's 529 before fall 2028", "high", amount=60000, date="2028-08-15",
                  feas="stretch", quote="To cover about sixty thousand"),
            _goal(h, "brooks_jordan_car", "Help Jordan buy a first car (family matches up to $4,000)", "low", amount=8500,
                  date="2027-06-30", feas="on_track", quote="Eight thousand five hundred gets you something decent with low miles"),
        ],
    })
    return convs
