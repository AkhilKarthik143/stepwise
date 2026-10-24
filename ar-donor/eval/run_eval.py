"""
Diagram-quality eval runner. Drives Gemini (text) with the SAME system
instruction + tool declarations as the live app, captures the first-turn tool
calls, and scores any `show_model` diagram for richness. Writes the raw outputs
to eval/results/ for the LLM-judge pass.

SPENDS Gemini quota (one generate_content per scenario) — run manually:

    python eval/run_eval.py [--limit N] [--model gemini-2.5-flash] [--temperature 0.4]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
from eval.scenarios import SCENARIOS  # noqa: E402
from eval.scoring import score_diagram  # noqa: E402
from google import genai  # noqa: E402
from google.genai import types  # noqa: E402

RESULTS_DIR = Path(__file__).resolve().parent / "results"


def _calls_and_text(resp) -> tuple[list[dict], str]:
    parts = (resp.candidates[0].content.parts if resp.candidates else None) or []
    calls, text = [], []
    for p in parts:
        fc = getattr(p, "function_call", None)
        if fc:
            calls.append({"name": fc.name, "args": dict(fc.args or {})})
        if getattr(p, "text", None):
            text.append(p.text)
    return calls, "".join(text)


def run_scenario(client, model: str, cfg, scenario: dict, retries: int = 3) -> dict:
    last_err = None
    for attempt in range(retries):
        try:
            resp = client.models.generate_content(model=model, contents=scenario["prompt"], config=cfg)
            calls, text = _calls_and_text(resp)
            tools = [c["name"] for c in calls]
            show = next((c for c in calls if c["name"] == "show_model"), None)
            return {
                "id": scenario["id"],
                "prompt": scenario["prompt"],
                "expect_tool": scenario["expect_tool"],
                "rationale": scenario["rationale"],
                "tools_called": tools,
                "tool_match": scenario["expect_tool"] in tools,
                "text": text,
                "show_model_args": show["args"] if show else None,
                "diagram_score": score_diagram(show["args"]) if show else None,
                "calls": calls,
            }
        except Exception as e:  # noqa: BLE001
            last_err = e
            msg = str(e)
            if "503" in msg or "UNAVAILABLE" in msg or "429" in msg:
                time.sleep(2 * (attempt + 1))
                continue
            break
    return {"id": scenario["id"], "prompt": scenario["prompt"], "error": f"{type(last_err).__name__}: {str(last_err)[:200]}"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="run only the first N scenarios (0 = all)")
    ap.add_argument("--model", default="gemini-2.5-flash")
    ap.add_argument("--temperature", type=float, default=0.4)
    args = ap.parse_args()

    client = genai.Client(api_key=config.GEMINI_API_KEY)
    cfg = types.GenerateContentConfig(
        system_instruction=config.SYSTEM_INSTRUCTION,
        tools=[types.Tool(function_declarations=config.TOOL_DECLARATIONS)],
        temperature=args.temperature,
    )
    scenarios = SCENARIOS[: args.limit] if args.limit else SCENARIOS

    results = []
    for sc in scenarios:
        print(f"... {sc['id']}", flush=True)
        r = run_scenario(client, args.model, cfg, sc)
        results.append(r)
        if "error" in r:
            print(f"    ERROR: {r['error']}")
        else:
            ds = r["diagram_score"]
            tag = f"diagram richness={ds['richness']} feats={ds['features']}" if ds else "no diagram"
            print(f"    tools={r['tools_called']} match={r['tool_match']} | {tag}")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "temperature": args.temperature,
        "count": len(results),
        "results": results,
    }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    (RESULTS_DIR / f"eval-{stamp}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (RESULTS_DIR / "latest.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    ok = [r for r in results if "error" not in r]
    matched = sum(1 for r in ok if r.get("tool_match"))
    diagrams = [r["diagram_score"] for r in ok if r.get("diagram_score")]
    avg_rich = round(sum(d["richness"] for d in diagrams) / len(diagrams), 1) if diagrams else 0
    print("\n=== SUMMARY ===")
    print(f"scenarios: {len(results)} | ran OK: {len(ok)} | expected-tool match: {matched}/{len(ok)}")
    print(f"diagrams produced: {len(diagrams)} | avg richness: {avg_rich}")
    print(f"results -> {RESULTS_DIR / 'latest.json'}")


if __name__ == "__main__":
    main()
