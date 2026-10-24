# Diagram-quality eval — report (2026-06-17)

Model: `gemini-2.5-flash` (text proxy for the live audio app) · system prompt +
tools from `config.py` · 8 scenarios, **6 completed** (2 hit a Gemini 429
quota cap — an external API limit, not a token budget). Raw data: `latest.json`.

## Scores (LLM-judged)

| Scenario | Tool | Tool OK | Diagram | Grounded | Notes |
|---|---|---|---|---|---|
| pump_exploded | show_model 3D | ✓ | 3/5 | ✓ | rich (glass housing, notes, materials, seal warning) but **not actually exploded** + proportions off |
| scissors_cut | show_model 2D | ✓ | 4/5 | ✓ | used `animate` swing — but handle/blade swing **directions contradict** (opens vs closes) |
| relay_wiring | show_model 2D | ✓ | 4/5 | ✓ | 13 labelled parts; **label/note contradiction** (NC vs "normally open"); no dashed/terminal #s |
| bolt_torque | query_technical_manual | ✓ | n/a | ✓ | correctly looked up torque + direction instead of guessing |
| rotor_clearance | query_technical_manual | ✓ | n/a | ✓ | grounded the spec, but **dropped the "show me where to measure" half** (no dimension call-out) |
| pump_head_steps | query_technical_manual | ✓ | n/a | ✓ | grounded the order, but **no stepped diagram** to "walk me through" |

## What's strong

- **Grounding is excellent**: 6/6 defensible tool choices; on all three hard-spec/
  procedure prompts it reached for `query_technical_manual` instead of inventing
  torque/clearance/repair-order values — exactly what the prompt mandates.
- **Diagrams are schema-valid (3/3)**, mode chosen sensibly (3D assembly / 2D
  schematic), **every part labelled**, and it layers in notes, materials, a
  see-through glass housing (opacity 0.3), a wear warning, and the correct
  `animate` swing-about-pivot primitive.

## What's weak (the eval's payoff — gaps unit tests can't see)

1. **"Exploded" wasn't exploded** — housing and shaft both at `[0,0,0]`, parts
   clustered at the origin with no axial separation.
2. **Proportion errors** — a 200-tall shaft protruding past a 150-tall housing
   ("stack up *inside* the housing").
3. **Kinematics inconsistency** — scissor handle and blade on the same rigid
   lever animated in *opposite* directions (handles open while blades close).
4. **Factual self-contradiction** — relay contact labelled `(NC)` but its note
   says "normally open."
5. **Half-served two-part requests** — "…and show me where to measure" /
   "walk me through step by step" got the lookup but **no chained `show_model`**
   (dimension call-out / stepped diagram).
6. Low richness where invited (relay: no `dashed` hidden runs, no terminal #s).

## Actions taken (loop closed in the same turn)

The clearly-correct, high-value findings were folded into the `show_model`
guidance as concrete rules + worked cautions:

- **Exploded** views must separate parts along one axis with gaps — never share
  identical positions.
- **Proportional sanity** — internal parts fit within their container.
- **Kinematics** — parts of one rigid body share the same `animate` axis +
  direction (the scissors case named explicitly).
- **Chain tools** — a request to *see / where / walk me through* should produce a
  `show_model` (dimension or `step`-tagged) **in addition to** any lookup.
- **Self-consistency** — a part's `label` and `note` must not contradict.

These are prompt-only (guarded by the description test) and **pending eval
re-validation** once quota resets.

## Follow-ups

- Re-run `terminal_safety` + `gearbox_seethrough` when quota allows (they probe
  the safety-refusal and see-through behaviours this 6/8 sample missed).
- The empty-text observation is partly a single-turn text-eval artifact (the live
  app speaks after the tool round-trip); the "narrate + acknowledge pending step"
  recommendation still stands.
