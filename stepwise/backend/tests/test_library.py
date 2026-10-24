"""Manual library: LEGO/IKEA search parsing, import limits, and a full background import
(generated PDF, fake page reader) that the guide can follow while pages are still being read."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.build.catalog import BuildCatalog
from app.build.guide import BuildGuide
from app.build.library import ImportRefused, Library, ikea_pdfs, parse_lego, search
from app.build.metrics import Metrics
from app.build.models import Crop, ExtractedStep, PageExtraction, Part

LEGO_HTML = (
    '<div><h3 class="x">Playful Cat (1/3)</h3><p class="y">19.96MB (PDF)</p></div>'
    '<a href="https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6512345.pdf">Download</a>'
    '<div><h3 class="x">Playful Cat (2/3)</h3><p class="y">12.1MB (PDF)</p></div>'
    '<a href="https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6512346.pdf">Download</a>'
)


def test_parse_lego_books():
    results = parse_lego(LEGO_HTML, "31163")
    assert [r["title"] for r in results] == ["Playful Cat", "Playful Cat"]
    assert results[0]["subtitle"] == "LEGO 31163 · Book 1 of 3"
    assert results[0]["pdf_url"] == "https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6512345.pdf"
    assert results[0]["size_label"] == "19.96MB"


def test_ikea_keeps_pdfs_named_after_the_product():
    page = ('"https://www.ikea.com/us/en/assembly_instructions/marius-stool-black__AA-1.pdf" '
            '"https://www.ikea.com/us/en/assembly_instructions/lack-side-table__AA-2.pdf"')
    assert ikea_pdfs(page, "MARIUS") == ["https://www.ikea.com/us/en/assembly_instructions/marius-stool-black__AA-1.pdf"]
    assert ikea_pdfs(page, "Nope") == ["https://www.ikea.com/us/en/assembly_instructions/marius-stool-black__AA-1.pdf"]


def test_search_routes_set_numbers_to_lego():
    class FakeClient:
        async def get(self, url, **kw):
            assert "buildinginstructions/31163" in url
            return SimpleNamespace(status_code=200, text=LEGO_HTML)

    out = asyncio.run(search("31163", client=FakeClient()))
    assert out["source"] == "lego" and len(out["results"]) == 2


def make_pdf(path, pages=3):
    import pymupdf

    doc = pymupdf.open()
    for n in range(pages):
        page = doc.new_page(width=400, height=300)
        page.draw_rect(pymupdf.Rect(100, 60, 300, 240), color=(0, 0, 0), fill=((0.2 + 0.2 * n) % 1.0, 0.4, 0.8))
    doc.save(path)


def fake_extract(settings, *, page_number, **kw):
    if page_number == 1:
        return PageExtraction(steps=[])  # a cover page
    return PageExtraction(steps=[ExtractedStep(step=page_number - 1, parts=[Part(name="brick 2x4", color="red")],
                                               action=f"Do step {page_number - 1}.", watch_for=[], crop=Crop(x0=200, y0=150, x1=800, y1=850))])


def test_import_refuses_other_hosts_and_non_pdfs(tmp_path):
    lib = Library(BuildCatalog(tmp_path), SimpleNamespace(anthropic_api_key="k", live_ingest_model="m"), extract=fake_extract)
    with pytest.raises(ImportRefused):
        asyncio.run(lib.import_url("https://evil.example/x.pdf", "X"))
    with pytest.raises(ImportRefused):
        asyncio.run(lib.import_bytes(b"not a pdf", "X"))


def test_import_reads_pages_in_background_and_the_guide_follows(tmp_path):
    pdf = tmp_path / "src.pdf"
    make_pdf(pdf)
    catalog = BuildCatalog(tmp_path / "builds")
    settings = SimpleNamespace(anthropic_api_key="k", live_ingest_model="m", check_min_confidence=0.7)

    async def scenario():
        lib = Library(catalog, settings, extract=fake_extract, fetch=None)
        job = await lib.import_bytes(pdf.read_bytes(), "Playful Cat")
        guide = BuildGuide(settings, catalog, Metrics(), is_reading=lib.is_reading)
        first = guide.load(job.build_id) if catalog.get(job.build_id) else None
        for _ in range(100):
            if job.status in ("done", "failed"):
                break
            await asyncio.sleep(0.05)
        return lib, job, guide, first

    lib, job, guide, first = asyncio.run(scenario())
    assert job.status == "done", job.error
    assert (job.pages_total, job.pages_done, job.steps_ready) == (3, 3, 2)
    build = catalog.get(job.build_id)
    assert build.title == "Playful Cat" and [s.step for s in build.steps] == [1, 2]
    assert (catalog.root / job.build_id / "steps" / "01.png").exists()
    assert "playful cat" in build.aliases
    guide.load(job.build_id)
    assert asyncio.run(guide.handle("what's next?", None)).text.startswith("You're on step 1.")
    assert asyncio.run(guide.handle("switch to the playful cat", None)).text.startswith("Switching to the Playful Cat.")


def test_guide_waits_while_the_first_pages_are_read(tmp_path):
    (tmp_path / "cat").mkdir()
    (tmp_path / "cat" / "build.json").write_text('{"build_id": "cat", "title": "Playful Cat", "steps": []}')
    catalog = BuildCatalog(tmp_path)
    guide = BuildGuide(SimpleNamespace(anthropic_api_key="k", check_min_confidence=0.7), catalog, Metrics(), is_reading=lambda b: True)
    assert guide.load("cat").text.startswith("Opening the Playful Cat.")
    assert "still reading" in asyncio.run(guide.handle("next", None)).text
    assert guide.status()["step"] is None and guide.status()["build"]["reading"] is True
