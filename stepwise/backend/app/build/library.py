"""Find and import manuals from the phone: LEGO by set number, IKEA by product name, or a PDF upload.

Search scrapes the same public pages a person would use: lego.com's building-instructions page for
a set number, and IKEA's public product search, then each product page's assembly PDFs.

An import downloads the PDF (from lego.com / ikea.com only) or takes the upload, renders the
pages, and reads them in the background, a few at a time, with the faster live-ingest model. The
build is usable as soon as its first pages are read: build.json is rewritten after every page
from the pages read so far, in order, and the catalog reloads.

Imported builds live on the server's disk. On a container host they last until the next
redeploy or restart; commit the build folder to keep one for good.
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import re
import time
import unicodedata
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import httpx
from PIL import Image

from app.build import ingest
from app.build import vision
from app.build.catalog import BuildCatalog, get_catalog
from app.build.models import Source
from app.config import get_settings

logger = logging.getLogger("stepwise.library")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
LEGO_PDF = "https://www.lego.com/cdn/product-assets/product.bi.core.pdf/"
ALLOWED_PDF_PREFIXES = (LEGO_PDF, "https://www.ikea.com/")
MAX_PDF_BYTES = 80_000_000
PAGE_DPI = 110
PARALLEL_PAGES = 3

_LEGO_CARD = re.compile(
    r'<h3[^>]*>([^<]+)</h3><p[^>]*>([^<]*)</p></div><a href="https://www\.lego\.com/cdn/product-assets/product\.bi\.core\.pdf/(\d+)\.pdf"'
)
_IKEA_PDF = re.compile(r'https://www\.ikea\.com/[^"\s]*assembly_instructions/[^"\s]+\.pdf')


def _clean(text: str) -> str:
    return html.unescape(text).strip()


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


# ── search ───────────────────────────────────────────────────────────────────
def parse_lego(page_html: str, set_number: str) -> list[dict[str, Any]]:
    results = []
    for raw_name, size, file_id in _LEGO_CARD.findall(page_html):
        name = _clean(raw_name)
        book = re.search(r"\((\d+)/(\d+)\)\s*$", name)
        results.append({
            "source": "lego",
            "title": re.sub(r"\s*\(\d+/\d+\)\s*$", "", name),
            "subtitle": f"LEGO {set_number}" + (f" · Book {book.group(1)} of {book.group(2)}" if book else ""),
            "cover_url": f"https://www.lego.com/cdn/product-assets/product.bi.core.img/{file_id}.png?format=webply&fit=crop&quality=75&width=400&height=400",
            "pdf_url": f"{LEGO_PDF}{file_id}.pdf",
            "size_label": re.sub(r"\s*\(PDF\)", "", _clean(size), flags=re.I),
        })
    return results


def ikea_pdfs(product_html: str, product_name: str) -> list[str]:
    """Assembly PDFs on a product page, keeping the ones named after this product."""
    found = list(dict.fromkeys(_IKEA_PDF.findall(product_html)))
    slug = slugify(product_name)
    own = [u for u in found if u.split("/assembly_instructions/")[1].startswith(slug)] if slug else []
    return own or found[:1]


async def search_lego(client: httpx.AsyncClient, set_number: str) -> list[dict[str, Any]]:
    res = await client.get(f"https://www.lego.com/en-us/service/buildinginstructions/{set_number}")
    return parse_lego(res.text, set_number) if res.status_code == 200 else []


async def search_ikea(client: httpx.AsyncClient, query: str) -> list[dict[str, Any]]:
    res = await client.get("https://sik.search.blue.cdtapps.com/us/en/search-result-page", params={"q": query, "size": 8, "types": "PRODUCT"})
    if res.status_code != 200:
        return []
    items = (((res.json().get("searchResultPage") or {}).get("products") or {}).get("main") or {}).get("items") or []

    async def one(product: dict) -> list[dict[str, Any]]:
        url = product.get("pipUrl") or ""
        if not url.startswith("https://www.ikea.com/"):
            return []
        try:
            page = await client.get(url)
        except httpx.HTTPError:
            return []
        if page.status_code != 200:
            return []
        name = product.get("name") or "IKEA"
        pdfs = ikea_pdfs(page.text, name)
        return [{
            "source": "ikea",
            "title": f"{name} {product.get('typeName') or ''}".strip(),
            "subtitle": f"IKEA {product.get('itemNo') or ''}".strip() + (f" · Part {i + 1} of {len(pdfs)}" if len(pdfs) > 1 else ""),
            "cover_url": product.get("mainImageUrl"),
            "pdf_url": pdf,
        } for i, pdf in enumerate(pdfs)]

    per_product = await asyncio.gather(*(one(item.get("product") or {}) for item in items[:6]))
    return [r for group in per_product for r in group]


async def search(query: str, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """A bare 4-7 digit number is a LEGO set; anything else searches IKEA."""
    q = (query or "").strip()
    if not 2 <= len(q) <= 80:
        return {"source": None, "results": []}
    is_set = bool(re.fullmatch(r"\d{4,7}(-\d)?", q))
    own_client = client is None
    client = client or httpx.AsyncClient(headers={"User-Agent": UA}, timeout=15, follow_redirects=True)
    try:
        found = await (search_lego(client, q.split("-")[0]) if is_set else search_ikea(client, q))
    finally:
        if own_client:
            await client.aclose()
    seen: set[str] = set()
    results = [r for r in found if not (r["pdf_url"] in seen or seen.add(r["pdf_url"]))]
    return {"source": "lego" if is_set else "ikea", "results": results}


# ── import ───────────────────────────────────────────────────────────────────
@dataclass
class ImportJob:
    build_id: str
    title: str
    status: str = "downloading"  # downloading | reading | done | failed
    pages_total: int = 0
    pages_done: int = 0
    steps_ready: int = 0
    error: str = ""
    started_at: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class ImportRefused(ValueError):
    pass


class Library:
    def __init__(self, catalog: BuildCatalog, settings, extract: Callable = vision.extract_page,
                 fetch: Callable | None = None) -> None:
        self.catalog = catalog
        self.settings = settings
        self.extract = extract
        self.fetch = fetch or self._download
        self.jobs: dict[str, ImportJob] = {}
        self._tasks: set[asyncio.Task] = set()

    def is_reading(self, build_id: str) -> bool:
        job = self.jobs.get(build_id)
        return bool(job) and job.status in ("downloading", "reading")

    def build_id_for(self, title: str, key: str) -> str:
        return f"{slugify(title)[:40] or 'manual'}-{hashlib.sha1(key.encode()).hexdigest()[:6]}"

    async def import_url(self, pdf_url: str, title: str, aliases: list[str] | None = None) -> ImportJob:
        if not any(pdf_url.startswith(p) for p in ALLOWED_PDF_PREFIXES) or not pdf_url.endswith(".pdf"):
            raise ImportRefused("Only LEGO and IKEA manual PDFs can be imported by link. Upload other PDFs.")
        build_id = self.build_id_for(title, pdf_url)
        return self._start(build_id, title, aliases, Source(title=title, url=pdf_url), pdf_url=pdf_url)

    async def import_bytes(self, data: bytes, title: str, aliases: list[str] | None = None) -> ImportJob:
        if not data.startswith(b"%PDF"):
            raise ImportRefused("That file isn't a PDF.")
        if len(data) > MAX_PDF_BYTES:
            raise ImportRefused("That PDF is too big (80 MB max).")
        build_id = self.build_id_for(title, hashlib.sha1(data).hexdigest())
        return self._start(build_id, title, aliases, Source(title=title), data=data)

    def _start(self, build_id: str, title: str, aliases: list[str] | None, source: Source, *, pdf_url: str = "", data: bytes = b"") -> ImportJob:
        if self.is_reading(build_id):
            return self.jobs[build_id]
        if not self.settings.anthropic_api_key:
            raise ImportRefused("Reading manuals needs the Claude key on the server.")
        job = self.jobs[build_id] = ImportJob(build_id=build_id, title=title)
        words = [w for w in slugify(title).split("-") if len(w) > 2][:3]
        names = list(dict.fromkeys([*(aliases or []), " ".join(words)] if words else (aliases or [])))
        task = asyncio.create_task(self._run(job, names, source, pdf_url, data), name=f"import-{build_id}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return job

    async def _download(self, url: str) -> bytes:
        async with httpx.AsyncClient(headers={"User-Agent": UA}, timeout=60, follow_redirects=True) as client:
            res = await client.get(url)
            res.raise_for_status()
            if len(res.content) > MAX_PDF_BYTES:
                raise ImportRefused("That PDF is too big (80 MB max).")
            return res.content

    async def _run(self, job: ImportJob, aliases: list[str], source: Source, pdf_url: str, data: bytes) -> None:
        folder = self.catalog.root / job.build_id
        try:
            folder.mkdir(parents=True, exist_ok=True)
            pdf = folder / "manual.pdf"
            if not pdf.exists():
                pdf.write_bytes(data or await self.fetch(pdf_url))
            total = await asyncio.to_thread(ingest.page_count, pdf)
            pages = list(range(1, total + 1))
            job.pages_total, job.status = total, "reading"
            await asyncio.to_thread(ingest.render, pdf, folder / "pages", pages, PAGE_DPI)

            done: set[int] = {n for n in pages if ingest.cached_page(folder, n) is not None}
            lock = asyncio.Lock()
            gate = asyncio.Semaphore(PARALLEL_PAGES)

            async def publish() -> None:
                # Only the unbroken run of pages read so far, so steps never skip ahead.
                prefix = []
                for n in pages:
                    if n not in done:
                        break
                    prefix.append(n)
                async with lock:
                    build = await asyncio.to_thread(ingest.assemble, folder, prefix, build_id=job.build_id,
                                                    title=job.title, aliases=aliases, source=source)
                    self.catalog.reload()
                job.pages_done, job.steps_ready = len(done), len(build.steps)

            async def read(n: int) -> None:
                async with gate:
                    page_png = folder / "pages" / f"{n:02d}.png"
                    try:
                        extraction = await asyncio.to_thread(
                            self.extract, self.settings, page_png=page_png.read_bytes(), page_number=n, title=job.title,
                            page_size=Image.open(page_png).size, model=self.settings.live_ingest_model, effort="low")
                        ingest.save_page(folder, n, extraction)
                    except Exception as exc:  # noqa: BLE001 — one bad page must not stop the manual
                        logger.warning("import %s page %s failed: %r", job.build_id, n, exc)
                    done.add(n)
                await publish()

            await publish()
            await asyncio.gather(*(read(n) for n in pages if n not in done))
            job.status = "done"
        except Exception as exc:  # noqa: BLE001
            logger.warning("import %s failed: %r", job.build_id, exc)
            job.status, job.error = "failed", str(exc) or exc.__class__.__name__


@lru_cache
def get_library() -> Library:
    return Library(get_catalog(), get_settings())
