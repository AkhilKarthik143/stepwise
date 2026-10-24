"""
Lightweight in-process metrics (no Prometheus/OpenTelemetry dependency).

Counters, gauges, and simple timers, exported in Prometheus text format at
/metrics. Everything runs on one asyncio loop (single thread), so plain dict
mutation is safe without locking. Forward these to whatever backend you scrape
with; for multi-worker deployments aggregate per-worker series.
"""
from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Iterator, Optional


def _key(name: str, labels: Optional[dict]) -> str:
    if not labels:
        return name
    inner = ",".join(f'{k}="{v}"' for k, v in sorted(labels.items()))
    return f"{name}{{{inner}}}"


class Metrics:
    def __init__(self) -> None:
        self._counters: dict[str, float] = {}
        self._gauges: dict[str, float] = {}
        # name -> {count, sum, max} (seconds)
        self._timers: dict[str, dict[str, float]] = {}

    # -- writers ------------------------------------------------------------
    def inc(self, name: str, amount: float = 1, labels: Optional[dict] = None) -> None:
        k = _key(name, labels)
        self._counters[k] = self._counters.get(k, 0) + amount

    def set_gauge(self, name: str, value: float, labels: Optional[dict] = None) -> None:
        self._gauges[_key(name, labels)] = value

    def observe(self, name: str, seconds: float, labels: Optional[dict] = None) -> None:
        k = _key(name, labels)
        t = self._timers.get(k)
        if t is None:
            t = self._timers[k] = {"count": 0, "sum": 0.0, "max": 0.0}
        t["count"] += 1
        t["sum"] += seconds
        t["max"] = max(t["max"], seconds)

    @contextmanager
    def time(self, name: str, labels: Optional[dict] = None) -> Iterator[None]:
        t0 = time.monotonic()
        try:
            yield
        finally:
            self.observe(name, time.monotonic() - t0, labels)

    def reset(self) -> None:
        self._counters.clear()
        self._gauges.clear()
        self._timers.clear()

    # -- readers ------------------------------------------------------------
    def snapshot(self) -> dict:
        return {
            "counters": dict(self._counters),
            "gauges": dict(self._gauges),
            "timers": {
                k: {
                    "count": v["count"],
                    "sum": round(v["sum"], 4),
                    "max": round(v["max"], 4),
                    "avg": round(v["sum"] / v["count"], 4) if v["count"] else 0.0,
                }
                for k, v in self._timers.items()
            },
        }

    def prometheus(self) -> str:
        lines: list[str] = []
        for k, v in sorted(self._counters.items()):
            lines.append(f"{_prefix(k, '_total')} {v}")
        for k, v in sorted(self._gauges.items()):
            lines.append(f"{k} {v}")
        for k, v in sorted(self._timers.items()):
            base = _split_labels(k)
            lines.append(f"{_with_suffix(base, '_seconds_count')} {v['count']}")
            lines.append(f"{_with_suffix(base, '_seconds_sum')} {round(v['sum'], 6)}")
            lines.append(f"{_with_suffix(base, '_seconds_max')} {round(v['max'], 6)}")
        return "\n".join(lines) + "\n"


def _prefix(key: str, suffix: str) -> str:
    # counters already carry their own name; ensure a _total suffix on the metric name
    name, _, labels = key.partition("{")
    if name.endswith("_total"):
        return key
    return f"{name}{suffix}" + (f"{{{labels}" if labels else "")


def _split_labels(key: str) -> tuple[str, str]:
    name, sep, labels = key.partition("{")
    return name, (sep + labels) if sep else ""


def _with_suffix(base: tuple[str, str], suffix: str) -> str:
    name, labels = base
    return f"{name}{suffix}{labels}"


# Process-wide singleton.
metrics = Metrics()
