"""Live demo numbers for the dashboard: steps done, mistakes caught, time per step, latency.

One process serves one demo table, so the latest session's numbers live in a module-level
store that ``GET /api/metrics`` reads (the dashboard runs on a second phone or laptop).
"""

from __future__ import annotations

import logging
import time
from dataclasses import asdict, dataclass, field

logger = logging.getLogger("stepwise.metrics")  # exported to Application Insights when enabled


@dataclass
class Metrics:
    build_id: str = ""
    build_title: str = ""
    step: int = 0
    total_steps: int = 0
    steps_done: int = 0
    mistakes_caught: int = 0
    overrides: int = 0
    checks: int = 0
    closer_looks: int = 0
    step_seconds: list[float] = field(default_factory=list)
    turn_ms: list[dict] = field(default_factory=list)  # {"kind": "command|check|question|part", "ms": int}
    updated_at: float = 0.0

    def record_turn(self, kind: str, ms: float) -> None:
        self.turn_ms = (self.turn_ms + [{"kind": kind, "ms": round(ms)}])[-50:]
        self.updated_at = time.time()
        logger.info("turn", extra={"kind": kind, "ms": round(ms), "build": self.build_id, "step": self.step,
                                   "mistakes_caught": self.mistakes_caught, "overrides": self.overrides})

    def snapshot(self) -> dict:
        data = asdict(self)
        times = self.step_seconds
        data["avg_step_seconds"] = round(sum(times) / len(times), 1) if times else None
        by_kind: dict[str, list[int]] = {}
        for t in self.turn_ms:
            by_kind.setdefault(t["kind"], []).append(t["ms"])
        data["median_ms"] = {k: sorted(v)[len(v) // 2] for k, v in by_kind.items()}
        return data


LATEST = Metrics()


def new_session() -> Metrics:
    global LATEST
    LATEST = Metrics()
    return LATEST
