"""Risk test: can the step check tell a correct build from a wrong one?

Take photos of a real build from the overhead camera position and name them
``<step>_ok_<anything>.jpg`` (step done right) or ``<step>_bad_<anything>.jpg`` (a staged
mistake), e.g. ``09_ok_1.jpg``, ``09_bad_rotated.jpg``. Then:

    cd stepwise/backend
    python scripts/check_steps.py --build app/data/builds/<build_id> --photos ~/risk-photos

The build folder needs ``steps/NN.png`` (the manual's picture after each step) and, ideally,
``build.json`` (parts and watch_for make the check sharper). The plan's bar is 13 of 15.
Needs ANTHROPIC_API_KEY (backend/.env is read automatically).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from app.build.models import Build, BuildStep  # noqa: E402
from app.build.vision import check_step  # noqa: E402
from app.config import get_settings  # noqa: E402

NAME = re.compile(r"^(\d+)_(ok|bad)\b", re.I)


def jpeg_b64(path: Path, max_side: int = 1280) -> str:
    img = Image.open(path).convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return base64.standard_b64encode(buf.getvalue()).decode()


def load_steps(build_dir: Path) -> dict[int, BuildStep]:
    path = build_dir / "build.json"
    if path.is_file():
        return {s.step: s for s in Build.model_validate_json(path.read_text()).steps}
    return {}


def judge(expect_ok: bool, result, min_conf: float) -> str:
    if result.confidence < min_conf:
        return "closer"  # asked for a closer look: safe, but not a pass
    looks_ok = result.step_complete and not result.issues
    return "right" if looks_ok == expect_ok else "wrong"


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", required=True, type=Path, help="build folder with steps/NN.png")
    ap.add_argument("--photos", required=True, type=Path, help="folder of <step>_ok|bad_*.jpg photos")
    args = ap.parse_args()

    settings = get_settings()
    if not settings.anthropic_api_key:
        print("ANTHROPIC_API_KEY is not set (put it in stepwise/backend/.env).")
        return 2
    steps = load_steps(args.build)
    photos = sorted(p for p in args.photos.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png") and NAME.match(p.name))
    if not photos:
        print(f"No photos named like 09_ok_1.jpg or 09_bad_rotated.jpg in {args.photos}")
        return 2

    rows, tally = [], {"right": 0, "wrong": 0, "closer": 0}
    for photo in photos:
        n, label = NAME.match(photo.name).groups()
        n, expect_ok = int(n), label.lower() == "ok"
        expected = args.build / "steps" / f"{n:02d}.png"
        previous = args.build / "steps" / f"{n - 1:02d}.png"
        if not expected.is_file():
            print(f"skip {photo.name}: missing {expected}")
            continue
        step = steps.get(n) or BuildStep(step=n, page=0, action="", expected_image=f"steps/{n:02d}.png")
        t0 = time.monotonic()
        try:
            result = await check_step(settings, expected=expected, previous=previous if previous.is_file() else None, frame_b64=jpeg_b64(photo), step=step)
        except Exception as exc:  # noqa: BLE001 — report and keep going
            print(f"{photo.name}: error {exc!r}")
            continue
        ms = (time.monotonic() - t0) * 1000
        verdict = judge(expect_ok, result, settings.check_min_confidence)
        tally[verdict] += 1
        issues = "; ".join(f"{i.part}: {i.problem}" for i in result.issues) or "-"
        print(f"{verdict:6} {photo.name:28} complete={result.step_complete!s:5} conf={result.confidence:.2f} {ms:6.0f} ms  {issues}")
        rows.append({"photo": photo.name, "expected": "ok" if expect_ok else "bad", "verdict": verdict, "latency_ms": round(ms), **result.model_dump()})

    total = sum(tally.values())
    latencies = sorted(r["latency_ms"] for r in rows)
    print(f"\n{tally['right']}/{total} judged right, {tally['closer']} asked for a closer look, {tally['wrong']} wrong.")
    if latencies:
        print(f"Latency: median {latencies[len(latencies) // 2]} ms, worst {latencies[-1]} ms.")
    print("Plan bar: 13 of 15. Under 10 of 15: bigger pieces, tighter crop, or check only on 'done'.")
    (args.photos / "check_results.json").write_text(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
