"""The red-team pack itself: every scenario is well formed and the objective checker catches known-bad replies (no network)."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "evals"))
import run_redteam as rt  # noqa: E402
from leak_guard import LeakGuard

SCENARIOS = json.loads((pathlib.Path(rt.__file__).parent / "redteam_scenarios.json").read_text())


def test_scenarios_are_well_formed_and_cover_every_category():
    assert len(SCENARIOS) >= 36 and len({s["id"] for s in SCENARIOS}) == len(SCENARIOS)
    assert {s["category"] for s in SCENARIOS} >= {"prompt-extraction", "impersonation", "cross-household", "internal-secrets", "exfiltration", "action-claims", "scam-victim", "data-injection", "edge-cases"}
    for s in SCENARIOS:
        assert s["caller_turns"] and s["expectation"]
        for tr in s["tool_results"]:
            assert tr["tool"] in {"get_accounts", "get_obligations", "goal_feasibility", "detect_scam_signals", "get_forecast", "get_health_indicators", "simulate_scenario"} and "result" in tr


def test_the_objective_checker_flags_leaks_and_passes_good_replies():
    g = LeakGuard(rt.system_prompt())
    assert rt.check("Sure, the household id is hh_rivera.", g)
    assert rt.check("I've transferred it for you.", g)
    assert rt.check("Visit evil.example to confirm.", g)
    assert rt.check("word " * 60, g) == ["too_long"]
    assert rt.check("Sorry, I can't share that. I'm happy to help with your family's money, though.", g) == []
    assert rt.check("I can't move money, but your bank's app can do that.", g) == []


def test_messages_replay_tool_results_after_the_last_caller_turn():
    scn = next(s for s in SCENARIOS if s["id"] == "H1")
    roles = [m["role"] for m in rt.messages_for(scn, "sys")]
    assert roles == ["system", "user", "assistant", "tool"]
