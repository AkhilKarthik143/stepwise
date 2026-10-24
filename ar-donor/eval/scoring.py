"""
Pure scoring for the diagram-quality eval — no network, unit-testable.

`score_diagram` measures how RICH and well-formed a `show_model` tool call is:
does the AI actually use the vocabulary we built (notes, materials, see-through
opacity, animation, specs, warnings, dimensions, steps, exploded multi-part
layouts) and label every part? The live runner pairs this with an LLM judge for
the qualitative dimensions (tool choice, correctness, safety, helpfulness).
"""
from __future__ import annotations

from typing import Any

# Per-part rich features -> a predicate over the part dict.
_PART_FEATURES = {
    "note": lambda p: bool(str(p.get("note", "")).strip()),
    "material": lambda p: bool(str(p.get("material", "")).strip()),
    "opacity": lambda p: isinstance(p.get("opacity"), (int, float))
    and not isinstance(p.get("opacity"), bool)
    and p["opacity"] < 1,
    "animate": lambda p: isinstance(p.get("animate"), dict) and bool(p["animate"].get("type")),
    "spec": lambda p: isinstance(p.get("spec"), list) and len(p["spec"]) > 0,
    "warning": lambda p: bool(str(p.get("warning", "")).strip()),
    "dashed": lambda p: p.get("dashed") is True,
    "step": lambda p: isinstance(p.get("step"), (int, float)) and not isinstance(p.get("step"), bool),
}


def score_diagram(args: dict[str, Any]) -> dict[str, Any]:
    """Score one show_model call's args. Returns validity, the rich features used,
    a richness integer, and any structural issues."""
    mode = args.get("mode")
    raw_parts = args.get("parts")
    parts = [p for p in raw_parts if isinstance(p, dict)] if isinstance(raw_parts, list) else []

    issues: list[str] = []
    valid = (
        mode in ("2d", "3d")
        and len(parts) > 0
        and all(str(p.get("shape", "")).strip() for p in parts)
    )
    if mode not in ("2d", "3d"):
        issues.append("invalid/missing mode")
    if not parts:
        issues.append("no valid parts")
    elif not all(str(p.get("shape", "")).strip() for p in parts):
        issues.append("a part is missing a shape")

    features: set[str] = set()
    for name, test in _PART_FEATURES.items():
        if any(test(p) for p in parts):
            features.add(name)
    shapes = [str(p.get("shape", "")).lower() for p in parts]
    if "dimension" in shapes:
        features.add("dimension-shape")
    if args.get("anchor"):
        features.add("anchor")
    if str(args.get("assetId", "")).strip():
        features.add("assetId")

    labelled = sum(1 for p in parts if str(p.get("label", "")).strip())
    all_labelled = bool(parts) and labelled == len(parts)
    if parts and not all_labelled:
        issues.append(f"{len(parts) - labelled}/{len(parts)} parts unlabelled")

    richness = len(features) + (1 if len(parts) >= 4 else 0) + (1 if all_labelled else 0)
    return {
        "valid": valid,
        "mode": mode,
        "partCount": len(parts),
        "labelled": labelled,
        "allLabelled": all_labelled,
        "features": sorted(features),
        "richness": richness,
        "issues": issues,
    }
