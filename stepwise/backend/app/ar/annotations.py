"""Validation for structured camera annotation events.

Camera coordinates are never derived from a schematic or an LLM. Confirmed boxes
must come from a user tap or a verified detector.
"""

from __future__ import annotations

from typing import Any

from app.data.catalog import catalog


def normalize_box(value: Any) -> list[int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        nums = [max(0, min(1000, int(float(v)))) for v in value]
    except (TypeError, ValueError):
        return None
    ymin, xmin, ymax, xmax = nums
    if ymax <= ymin or xmax <= xmin:
        return None
    return [ymin, xmin, ymax, xmax]


def confirmed_anchor(component_id: str, box: Any, *, source: str = "user_confirmed") -> dict[str, Any] | None:
    resolved = catalog.resolve_hotspot(component_id)
    if resolved is None:
        for diagram in catalog.diagram_types():
            found = catalog.resolve_component(diagram, component_id)
            if found:
                resolved = found
                break
    normalized = normalize_box(box)
    if resolved is None or normalized is None or source not in {"user_confirmed", "aruco", "verified_detector"}:
        return None
    key, payload = resolved
    return {
        "type": "ar.annotation.add",
        "annotation_id": f"{key}:camera",
        "component_id": key,
        "label": payload.get("label") or key.replace("_", " ").title(),
        "shape": "box",
        "severity": "info",
        "anchor": {"type": "image_bbox", "coordinates": normalized, "coordinate_system": "normalized_1000", "source": source},
        "tracking_status": "confirmed",
        "persistent": True,
    }
