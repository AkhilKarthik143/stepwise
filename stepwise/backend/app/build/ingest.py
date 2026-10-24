"""Turning a manual PDF into a build folder: render pages, read each page once, cut step pictures.

Shared by ``scripts/ingest_manual.py`` (offline, Opus, reviewed by a person) and the in-app
import (``app/build/library.py``: background, page by page, usable as soon as the first pages
are read). Each page's answer is cached in ``pages/NN.json``, so a page is only paid for once.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from app.build.models import Build, BuildStep, Crop, PageExtraction, Source


def parse_pages(spec: str | None, count: int) -> list[int]:
    if not spec:
        return list(range(1, count + 1))
    pages: set[int] = set()
    for part in spec.split(","):
        a, _, b = part.partition("-")
        pages.update(range(int(a), int(b or a) + 1))
    return sorted(p for p in pages if 1 <= p <= count)


def page_count(pdf: Path) -> int:
    import pymupdf

    with pymupdf.open(pdf) as doc:
        return doc.page_count


def render(pdf: Path, out: Path, pages: list[int], dpi: int) -> None:
    import pymupdf

    out.mkdir(parents=True, exist_ok=True)
    with pymupdf.open(pdf) as doc:
        for n in pages:
            target = out / f"{n:02d}.png"
            if not target.exists():
                doc[n - 1].get_pixmap(dpi=dpi).save(target)


def crop_ok(crop: Crop) -> bool:
    return all(0 <= v <= 1000 for v in (crop.x0, crop.y0, crop.x1, crop.y1)) and crop.x1 > crop.x0 and crop.y1 > crop.y0


def ink(path: Path) -> float:
    """Share of non-white pixels: a crop that missed the drawing is almost all white."""
    img = Image.open(path).convert("L")
    img.thumbnail((200, 200))
    hist = img.histogram()
    return sum(hist[:200]) / max(1, sum(hist))


def cut(page_png: Path, crop: Crop, target: Path, pad: int = 15) -> None:
    img = Image.open(page_png)
    w, h = img.size
    c = lambda v: max(0, min(1000, v))  # noqa: E731 — clamp stray coordinates onto the page
    box = (
        max(0, (c(crop.x0) - pad) * w // 1000), max(0, (c(crop.y0) - pad) * h // 1000),
        min(w, (c(crop.x1) + pad) * w // 1000), min(h, (c(crop.y1) + pad) * h // 1000),
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    img.crop(box).save(target)


def bad_steps(build: Build, folder: Path) -> list[BuildStep]:
    """Steps whose crop is off the page or nearly blank."""
    bad = []
    for s in build.steps:
        picture = folder / s.expected_image
        if not s.crop or not crop_ok(s.crop) or not picture.exists() or ink(picture) < 0.03:
            bad.append(s)
    return bad


def cached_page(folder: Path, n: int) -> PageExtraction | None:
    path = folder / "pages" / f"{n:02d}.json"
    return PageExtraction.model_validate_json(path.read_text()) if path.exists() else None


def save_page(folder: Path, n: int, extraction: PageExtraction) -> None:
    (folder / "pages" / f"{n:02d}.json").write_text(extraction.model_dump_json(indent=2))


def assemble(folder: Path, pages: list[int], *, build_id: str, title: str, aliases: list[str], source: Source | None) -> Build:
    """Build build.json from the cached page answers (pages in order), cutting each step's picture."""
    found: dict[int, BuildStep] = {}
    for n in pages:
        extraction = cached_page(folder, n)
        if extraction is None:
            continue
        for s in extraction.steps:
            if s.step in found:
                continue  # a step drawn twice (e.g. a recap) keeps its first appearance
            step = BuildStep(step=s.step, page=n, parts=s.parts, action=s.action, watch_for=s.watch_for, crop=s.crop, expected_image=f"steps/{s.step:02d}.png")
            picture = folder / step.expected_image
            if not picture.exists():
                cut(folder / "pages" / f"{n:02d}.png", s.crop, picture)
            found[s.step] = step
    build = Build(build_id=build_id, title=title, aliases=aliases, source=source, steps=[found[k] for k in sorted(found)])
    (folder / "build.json").write_text(build.model_dump_json(indent=2))
    return build
