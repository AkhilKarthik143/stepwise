"""Builds on disk: one folder per build under ``app/data/builds`` (or ``STEPWISE_BUILDS_DIR``).

    <builds>/<build_id>/build.json   steps, parts, actions, watch_for, crops
    <builds>/<build_id>/steps/NN.png expected picture for each step (cropped from the manual)
    <builds>/<build_id>/pages/NN.png full manual pages (ingestion input, kept for re-cropping)

``scripts/ingest_manual.py`` writes these; a person reviews ``build.json`` before the demo.
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache
from pathlib import Path

from app.build.models import Build, BuildStep

logger = logging.getLogger("stepwise.builds")

DEFAULT_DIR = Path(__file__).resolve().parents[1] / "data" / "builds"


def builds_dir() -> Path:
    return Path(os.environ.get("STEPWISE_BUILDS_DIR", DEFAULT_DIR))


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).split())


class BuildCatalog:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or builds_dir()
        self.builds: dict[str, Build] = {}
        self.reload()

    def reload(self) -> None:
        self.builds = {}
        if not self.root.is_dir():
            return
        for path in sorted(self.root.glob("*/build.json")):
            try:
                build = Build.model_validate_json(path.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001 — one bad file must not hide the rest
                logger.warning("skipping %s: %s", path, exc)
                continue
            self.builds[build.build_id] = build

    def get(self, build_id: str) -> Build | None:
        return self.builds.get(build_id)

    def first(self) -> Build | None:
        return next(iter(self.builds.values()), None)

    def resolve(self, text: str) -> Build | None:
        """Pick the build named in a phrase ("switch to the stool"). Longest name wins."""
        said = f" {_norm(text)} "
        best: tuple[int, Build] | None = None
        for build in self.builds.values():
            for name in (build.build_id, build.title, *build.aliases):
                n = _norm(name)
                if n and f" {n} " in said and (best is None or len(n) > best[0]):
                    best = (len(n), build)
        return best[1] if best else None

    def image_path(self, build_id: str, relative: str) -> Path | None:
        """Absolute path of a file inside a build folder, refusing anything that escapes it."""
        base = (self.root / build_id).resolve()
        path = (base / relative).resolve()
        if base not in path.parents or not path.is_file():
            return None
        return path

    def step_image(self, build: Build, step: BuildStep) -> Path | None:
        return self.image_path(build.build_id, step.expected_image)


@lru_cache
def get_catalog() -> BuildCatalog:
    return BuildCatalog()
