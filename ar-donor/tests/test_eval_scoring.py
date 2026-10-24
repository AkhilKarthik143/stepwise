"""Offline tests for the eval harness — pure scoring + scenario hygiene. These
NEVER call the API (the live run is `python eval/run_eval.py`, run manually)."""
from eval.scenarios import SCENARIOS
from eval.scoring import score_diagram


def test_scenarios_well_formed():
    assert len(SCENARIOS) >= 6
    ids = [s["id"] for s in SCENARIOS]
    assert len(ids) == len(set(ids)), "scenario ids must be unique"
    for s in SCENARIOS:
        assert s["prompt"].strip() and s["expect_tool"].strip() and s["rationale"].strip()


def test_score_diagram_counts_rich_features():
    s = score_diagram({
        "mode": "3d",
        "title": "x",
        "parts": [
            {"shape": "box", "label": "a", "note": "n", "material": "metal"},
            {"shape": "cylinder", "label": "b", "opacity": 0.3, "animate": {"type": "swing"}},
            {"shape": "sphere", "label": "c", "spec": [{"label": "T", "value": "25 Nm"}], "warning": "hot"},
            {"shape": "cone", "label": "d"},
        ],
    })
    assert s["valid"] and s["partCount"] == 4 and s["allLabelled"]
    assert {"note", "material", "opacity", "animate", "spec", "warning"} <= set(s["features"])
    assert s["richness"] >= 8  # 6 features + (>=4 parts) + (all labelled)


def test_score_diagram_flags_invalid_and_sparse():
    bad = score_diagram({"mode": "xx", "parts": []})
    assert not bad["valid"] and bad["issues"]
    sparse = score_diagram({"mode": "2d", "parts": [{"shape": "rect"}]})  # 1 unlabelled, no extras
    assert sparse["valid"] and sparse["features"] == [] and not sparse["allLabelled"]
    assert sparse["richness"] == 0
