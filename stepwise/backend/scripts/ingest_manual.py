"""Turn an instruction-manual PDF into a BuildSight build (run once per manual).

    cd stepwise/backend
    python scripts/ingest_manual.py --pdf ~/Downloads/60400.pdf --build-id lego-van \\
        --title "LEGO City Go-Kart" --aliases "lego,kart" --source-url https://www.lego.com/... --pages 4-30

What it does:
  1. renders each page to app/data/builds/<id>/pages/NN.png
  2. Claude Opus reads each page and returns its steps (parts, action, watch_for, crop box);
     answers are cached in pages/NN.json, so a re-run only pays for new pages
  3. crops each step's picture to steps/NN.png and writes build.json

Then a person reviews it (the plan's supervisor approval):
  - open build.json, fix any wrong part, action or crop box, set "approved": true
  - re-cut the pictures after editing crops:  python scripts/ingest_manual.py --build-id lego-van --recrop
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from app.build.catalog import builds_dir  # noqa: E402
from app.build.models import Build, BuildStep, Crop, PageExtraction, Source  # noqa: E402
from app.build.vision import extract_page  # noqa: E402
from app.config import get_settings  # noqa: E402


def parse_pages(spec: str | None, count: int) -> list[int]:
    if not spec:
        return list(range(1, count + 1))
    pages: set[int] = set()
    for part in spec.split(","):
        a, _, b = part.partition("-")
        pages.update(range(int(a), int(b or a) + 1))
    return sorted(p for p in pages if 1 <= p <= count)


def render(pdf: Path, out: Path, pages: list[int], dpi: int) -> None:
    import pymupdf

    out.mkdir(parents=True, exist_ok=True)
    with pymupdf.open(pdf) as doc:
        for n in pages:
            target = out / f"{n:02d}.png"
            if not target.exists():
                doc[n - 1].get_pixmap(dpi=dpi).save(target)


def cut(page_png: Path, crop: Crop, target: Path, pad: int = 15) -> None:
    img = Image.open(page_png)
    w, h = img.size
    box = (
        max(0, (crop.x0 - pad) * w // 1000), max(0, (crop.y0 - pad) * h // 1000),
        min(w, (crop.x1 + pad) * w // 1000), min(h, (crop.y1 + pad) * h // 1000),
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    img.crop(box).save(target)


def recrop(folder: Path) -> None:
    build = Build.model_validate_json((folder / "build.json").read_text())
    for step in build.steps:
        if step.crop:
            cut(folder / "pages" / f"{step.page:02d}.png", step.crop, folder / step.expected_image)
    print(f"Re-cut {len(build.steps)} step pictures in {folder / 'steps'}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build-id", required=True, help="folder name, e.g. lego-van")
    ap.add_argument("--pdf", type=Path)
    ap.add_argument("--title")
    ap.add_argument("--aliases", default="", help="comma-separated names said aloud to switch to it")
    ap.add_argument("--source-url", default="")
    ap.add_argument("--pages", help="e.g. 4-30 or 4,6,8-12 (default: all)")
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--recrop", action="store_true", help="re-cut steps/ from build.json crops, no Claude calls")
    args = ap.parse_args()

    folder = builds_dir() / args.build_id
    if args.recrop:
        recrop(folder)
        return 0
    if not args.pdf or not args.title:
        ap.error("--pdf and --title are required unless --recrop")
    settings = get_settings()
    if not settings.anthropic_api_key:
        print("ANTHROPIC_API_KEY is not set (put it in stepwise/backend/.env).")
        return 2

    import pymupdf

    with pymupdf.open(args.pdf) as doc:
        pages = parse_pages(args.pages, doc.page_count)
    render(args.pdf, folder / "pages", pages, args.dpi)

    found: dict[int, BuildStep] = {}
    for n in pages:
        page_png = folder / "pages" / f"{n:02d}.png"
        cache = folder / "pages" / f"{n:02d}.json"
        if cache.exists():
            extraction = PageExtraction.model_validate_json(cache.read_text())
        else:
            print(f"page {n}: reading with {settings.ingest_model}…", flush=True)
            extraction = extract_page(settings, page_png=page_png.read_bytes(), page_number=n, title=args.title)
            cache.write_text(extraction.model_dump_json(indent=2))
        for s in extraction.steps:
            if s.step in found:
                continue  # a step drawn twice (e.g. a recap) keeps its first appearance
            found[s.step] = BuildStep(step=s.step, page=n, parts=s.parts, action=s.action, watch_for=s.watch_for, crop=s.crop, expected_image=f"steps/{s.step:02d}.png")
            cut(page_png, s.crop, folder / found[s.step].expected_image)

    build = Build(
        build_id=args.build_id,
        title=args.title,
        aliases=[a.strip() for a in args.aliases.split(",") if a.strip()],
        source=Source(title=args.title, url=args.source_url),
        steps=[found[k] for k in sorted(found)],
    )
    (folder / "build.json").write_text(build.model_dump_json(indent=2))
    numbers = sorted(found)
    gaps = sorted(set(range(numbers[0], numbers[-1] + 1)) - set(numbers)) if numbers else []
    print(f"\nWrote {len(numbers)} steps to {folder / 'build.json'}")
    if gaps:
        print(f"Missing step numbers (check those pages): {gaps}")
    print("Next: review build.json against the manual, fix crops, set approved: true, then --recrop.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
