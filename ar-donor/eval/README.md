# Diagram-quality eval

A lightweight harness that measures **whether the AI actually produces good
diagrams and grounds its facts** — the quality the prompt + tool schema are
meant to drive, separate from the renderer (which the unit tests + the GLTF
browser check already cover).

## What it does

`run_eval.py` drives Gemini (text) with the **real** `SYSTEM_INSTRUCTION` and
`TOOL_DECLARATIONS` from `config.py`, over a set of representative
field-technician requests (`scenarios.py`). For each it captures the first-turn
tool call(s) and, for any `show_model`, scores the diagram's **richness** (does
it use notes, materials, see-through opacity, animation, specs, warnings,
dimensions, steps, an exploded multi-part layout, and label every part) via the
pure, unit-tested `scoring.py`.

A second pass (an LLM judge, run as a Workflow) reads the captured outputs and
scores the qualitative dimensions — tool choice, grounding, correctness, and
whether it would genuinely help a technician — and synthesizes findings into
`results/REPORT.md`.

## Run it

```bash
python eval/run_eval.py                 # all scenarios (one Gemini call each)
python eval/run_eval.py --limit 3       # first 3 only
python eval/run_eval.py --model gemini-2.5-flash --temperature 0.4
```

It **spends Gemini quota** (one `generate_content` per scenario) and uses
`GEMINI_API_KEY` from `.env`. Raw outputs land in `results/` (`latest.json` +
a timestamped copy). The text path is a faithful proxy for the live audio app's
diagram/grounding behaviour — it exercises the same system prompt + tools.

## CI safety

The offline pieces (`scoring.py`, `scenarios.py`) are unit-tested in
`tests/test_eval_scoring.py` and never hit the network, so CI stays quota-free.
Only the manual `run_eval.py` and the judge Workflow call the API.
