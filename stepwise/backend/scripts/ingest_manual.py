"""Turn an instruction-manual PDF into a BuildSight build (run once per manual).

    cd stepwise/backend
    python scripts/ingest_manual.py --pdf ~/Downloads/60400.pdf --build-id lego-van \\
        --title "LEGO City Go-Kart" --aliases "lego,kart" --source-url https://www.lego.com/... --pages 4-30

What it does:
  1. renders each page to app/data/builds/<id>/pages/NN.png
  2. Claude Opus reads each page and returns its steps (parts, action, watch_for, crop box);
     answers are cached in pages/NN.json, so a re-run only pays for new pages
  3. crops each step's picture to steps/NN.png and writes build.json

The script flags crops that look wrong (off the page, or nearly blank). Re-ask Claude for just those
pages (other pages come from the cache, free):  ... --redo-pages 6,7,17

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
from app.build.ingest import assemble, bad_steps, cached_page, cut, page_count, parse_pages, render, save_page  # noqa: E402
from app.build.models import Build, Source  # noqa: E402
from app.build.vision import extract_page  # noqa: E402
from app.config import get_settings  # noqa: E402


def report(build: Build, folder: Path) -> list[int]:
    """Print the steps whose crop looks wrong, with the pages to redo."""
    bad = bad_steps(build, folder)
    if bad:
        pages = sorted({s.page for s in bad})
        print(f"\nCrops to check: steps {[s.step for s in bad]} (pages {pages}).")
        print(f"Re-ask Claude for those pages: add --redo-pages {','.join(map(str, pages))} to the same command.")
    return [s.step for s in bad]


def recrop(folder: Path) -> None:
    build = Build.model_validate_json((folder / "build.json").read_text())
    for step in build.steps:
        if step.crop:
            cut(folder / "pages" / f"{step.page:02d}.png", step.crop, folder / step.expected_image)
    print(f"Re-cut {len(build.steps)} step pictures in {folder / 'steps'}")
    report(build, folder)


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
    ap.add_argument("--redo-pages", help="pages to re-ask Claude about, e.g. 6,7,17 (ignores their cache)")
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

    pages = parse_pages(args.pages, page_count(args.pdf))
    render(args.pdf, folder / "pages", pages, args.dpi)
    for n in parse_pages(args.redo_pages, max(pages)) if args.redo_pages else []:
        (folder / "pages" / f"{n:02d}.json").unlink(missing_ok=True)
        for old in (folder / "steps").glob("*.png") if (folder / "steps").is_dir() else []:
            old.unlink()  # re-cut every picture: a redone page can renumber its steps

    for n in pages:
        if cached_page(folder, n) is None:
            print(f"page {n}: reading with {settings.ingest_model}…", flush=True)
            page_png = folder / "pages" / f"{n:02d}.png"
            save_page(folder, n, extract_page(settings, page_png=page_png.read_bytes(), page_number=n, title=args.title, page_size=Image.open(page_png).size))

    aliases = [a.strip() for a in args.aliases.split(",") if a.strip()]
    build = assemble(folder, pages, build_id=args.build_id, title=args.title, aliases=aliases, source=Source(title=args.title, url=args.source_url))
    numbers = [st.step for st in build.steps]
    gaps = sorted(set(range(numbers[0], numbers[-1] + 1)) - set(numbers)) if numbers else []
    print(f"\nWrote {len(numbers)} steps to {folder / 'build.json'}")
    if gaps:
        print(f"Missing step numbers (check those pages): {gaps}")
    report(build, folder)
    print("Next: review build.json against the manual, fix crops, set approved: true, then --recrop.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
