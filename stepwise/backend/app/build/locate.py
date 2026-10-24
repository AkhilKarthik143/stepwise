"""Contact sheets for "where am I?": every step picture of a build, tiled and numbered.

Claude compares one camera frame with these sheets (a handful of images instead of one per step)
and names the last step that looks finished. Sheets are cached per build and rebuilt when the
build gains steps (a manual still being read).
"""

from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

from app.build.catalog import BuildCatalog
from app.build.models import Build

TILE = 180
COLS = 6
ROWS = 5
PER_SHEET = COLS * ROWS

_cache: dict[tuple[str, int], list[tuple[bytes, list[int]]]] = {}


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # older Pillow: fixed-size default font
        return ImageFont.load_default()


def contact_sheets(catalog: BuildCatalog, build: Build) -> list[tuple[bytes, list[int]]]:
    """PNG sheets, each with the step numbers it shows (in tile order)."""
    key = (build.build_id, len(build.steps))
    if key in _cache:
        return _cache[key]
    label_font = _font(28)
    sheets: list[tuple[bytes, list[int]]] = []
    steps = build.steps
    for start in range(0, len(steps), PER_SHEET):
        chunk = steps[start:start + PER_SHEET]
        rows = (len(chunk) + COLS - 1) // COLS
        sheet = Image.new("RGB", (COLS * TILE, rows * TILE), "white")
        draw = ImageDraw.Draw(sheet)
        for i, step in enumerate(chunk):
            x, y = (i % COLS) * TILE, (i // COLS) * TILE
            path = catalog.step_image(build, step)
            if path:
                pic = Image.open(path).convert("RGB")
                pic.thumbnail((TILE - 12, TILE - 40))
                sheet.paste(pic, (x + (TILE - pic.width) // 2, y + 34 + (TILE - 40 - pic.height) // 2))
            draw.rectangle([x, y, x + TILE - 1, y + TILE - 1], outline=(180, 180, 180))
            draw.rectangle([x, y, x + 64, y + 32], fill=(20, 20, 20))
            draw.text((x + 6, y + 1), str(step.step), fill="white", font=label_font)
        buf = io.BytesIO()
        sheet.save(buf, "PNG")
        sheets.append((buf.getvalue(), [s.step for s in chunk]))
    _cache[key] = sheets
    return sheets
