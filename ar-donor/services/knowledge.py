"""
NotebookLM RAG tool (v2 — speed-optimized).
===========================================

Single responsibility: given a natural-language query, return a clean, factual,
*citation-grounded* text block that the Gemini model can read aloud or
paraphrase to the technician. Knows nothing about WebRTC or Gemini.

Backed by `notebooklm-py` (https://github.com/teng-lin/notebooklm-py), an
unofficial async client for Google NotebookLM. Contract (verified against the
repo's docs/python-api.md):

    async with NotebookLMClient.from_storage() as client:   # NOT awaited
        result = await client.chat.ask(notebook_id, query)  # -> AskResult
        result.answer / result.references[ChatReference(source_id, citation_number, cited_text)]

Speed model (v2). NotebookLM is never sub-second for a novel complex query, so
we make the COMMON path instant and hide the cold start:
  * Warm singleton client — one long-lived NotebookLMClient opened in the app
    lifespan (the repo's recommended production pattern), so we skip per-call
    connect/auth setup. Falls back to a per-call client if the singleton is
    unavailable (keeps tests + degraded boots working).
  * L1 exact cache — TTL+LRU on the normalized query; repeat questions are free.
  * Pre-warm — fire a throwaway query on startup/connect so NotebookLM's cold
    start happens before the technician asks.

Loop-affinity rule (docs §Concurrency contract): a NotebookLMClient is bound to
the event loop it was opened on (ChatAPI.ask calls assert_bound_loop()). The
whole app runs on one asyncio loop; the warm client is opened in the lifespan on
that loop and every query runs on it. Per-call fallback clients are likewise
opened+used+closed within a single coroutine on the same loop.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from typing import Any, Optional

import config
from services import retrieval
from services.metrics import metrics

logger = logging.getLogger("knowledge")

# Import is wrapped so the rest of the app can still boot (and report a clean
# error to Gemini) even if notebooklm-py isn't installed yet. We also import the
# specific exception types so the live tool turn can return tailored guidance.
try:
    from notebooklm import (  # type: ignore
        AuthError,
        NotebookLMError,
        NotebookNotFoundError,
        RateLimitError,
        RPCError,
        NotebookLMClient,
    )
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - environment dependent
    NotebookLMClient = None  # type: ignore
    _IMPORT_ERROR = exc

    # Placeholder exception types so the except-clauses below never NameError.
    class _NotebookLMUnavailable(Exception):
        ...

    AuthError = NotebookNotFoundError = RateLimitError = RPCError = NotebookLMError = (
        _NotebookLMUnavailable
    )

# Spoken when the notebook returns no grounded answer. Never cached.
_NO_ANSWER = (
    "The technical manual returned no answer for that query. Tell the technician "
    "you could not find that value and to avoid guessing."
)

# Warm singleton + pre-warm state (module-level; managed by startup()/shutdown()).
_warm_client: Optional[Any] = None
_warm_ctx: Optional[Any] = None
_prewarm_task: Optional[asyncio.Task] = None
_prewarm_lock = asyncio.Lock()

# Bounds concurrent LIVE NotebookLM round-trips server-wide. A single Gemini
# toolCall frame can now carry several query_technical_manual calls dispatched
# concurrently; without this, that fans out into unbounded simultaneous asks
# (rate limits / load). Cache hits never reach the guarded path. Built lazily so
# it binds to the running loop and reads the configured cap.
_lookup_sem: Optional[asyncio.Semaphore] = None


def _lookup_semaphore() -> asyncio.Semaphore:
    global _lookup_sem
    if _lookup_sem is None:
        _lookup_sem = asyncio.Semaphore(max(1, int(config.NOTEBOOKLM_MAX_CONCURRENT_LOOKUPS)))
    return _lookup_sem
_last_prewarm: float = 0.0
_PREWARM_MIN_INTERVAL = 120.0  # debounce repeated pre-warms


# ===========================================================================
# L1 cache — tiny TTL + LRU (no external dependency).
# ===========================================================================
class _TTLCache:
    def __init__(self, maxsize: int, ttl: float) -> None:
        self._maxsize = maxsize
        self._ttl = ttl
        self._data: "OrderedDict[str, tuple[float, str]]" = OrderedDict()

    @property
    def enabled(self) -> bool:
        return self._maxsize > 0 and self._ttl > 0

    def get(self, key: str) -> Optional[str]:
        if not self.enabled:
            return None
        item = self._data.get(key)
        if item is None:
            return None
        expiry, value = item
        if time.monotonic() >= expiry:
            self._data.pop(key, None)
            return None
        self._data.move_to_end(key)  # LRU touch
        return value

    def put(self, key: str, value: str) -> None:
        if not self.enabled:
            return
        self._data[key] = (time.monotonic() + self._ttl, value)
        self._data.move_to_end(key)
        while len(self._data) > self._maxsize:
            self._data.popitem(last=False)  # evict least-recently-used

    def clear(self) -> None:
        self._data.clear()


_cache = _TTLCache(config.NOTEBOOKLM_CACHE_MAXSIZE, config.NOTEBOOKLM_CACHE_TTL_SECONDS)

# L2 — near-duplicate answer cache (token-cosine over prior queries). maxsize=0
# (when the feature flag is off) makes it a no-op via SimilarityCache.enabled.
_sim_cache = retrieval.SimilarityCache(
    maxsize=config.NOTEBOOKLM_SIMILARITY_MAXSIZE if config.NOTEBOOKLM_SIMILARITY_CACHE else 0,
    ttl=config.NOTEBOOKLM_CACHE_TTL_SECONDS,
    threshold=config.NOTEBOOKLM_SIMILARITY_THRESHOLD,
)

# L3 — local BM25 index over the notebook fulltext (built in the background).
_bm25 = retrieval.Bm25Index()
_index_task: Optional[asyncio.Task] = None
_index_built = False


def _cache_key(query: str) -> str:
    return " ".join(query.lower().split())


# Side-cache of human-readable SOURCE TITLES behind each grounded answer, keyed by
# the SAME _cache_key as the L1 string cache. Read by last_source_titles() AFTER
# fetch_technical_guidance returns, so the client can show a "grounded by …" chip
# regardless of which tier served the answer. The string contract + L1/L2/L3
# caches are completely untouched (no answer text rides here).
#
# It must track the answer EXACTLY, or it lies about provenance (worse than no
# chip). Two invariants enforce that: (1) _store_titles is UNCONDITIONAL — every
# answer-producing path stores its titles, and an answer with NO grounding POPS
# any stale entry, so a re-ask that loses grounding can't keep an old source;
# (2) entries carry the SAME TTL as the answer cache, so a title can never
# outlive the answer it described (closes the L1-expiry / L2-paraphrase windows).
_titles_cache: "OrderedDict[str, tuple[float, list[str]]]" = OrderedDict()


def _store_titles(key: str, titles: list[str]) -> None:
    """Set the source titles for a query key so they track the answer exactly.

    Non-empty -> store (TTL-bounded, LRU). Empty -> POP any stale entry, so an
    ungrounded/degraded answer never inherits a previous answer's provenance.
    """
    if not titles:
        _titles_cache.pop(key, None)
        return
    _titles_cache[key] = (time.monotonic() + config.NOTEBOOKLM_CACHE_TTL_SECONDS, titles)
    _titles_cache.move_to_end(key)
    while len(_titles_cache) > config.NOTEBOOKLM_CACHE_MAXSIZE:
        _titles_cache.popitem(last=False)


def last_source_titles(query: str) -> list[str]:
    """Source titles behind the most-recent grounded answer to `query`, or [].

    Expired entries (past the answer-cache TTL) are treated as absent and pruned,
    so provenance never outlives the answer it described.
    """
    key = _cache_key(query)
    item = _titles_cache.get(key)
    if item is None:
        return []
    expiry, titles = item
    if time.monotonic() >= expiry:
        _titles_cache.pop(key, None)
        return []
    return list(titles)


def clear_cache() -> None:
    """Drop all cached answers (used by tests + on manual invalidation).

    Clears the L1 exact + L2 similarity caches and resets the L3 local index so
    tests start from a clean slate. The index is rebuilt from the live notebook on
    the next startup() (never in tests, which don't open a warm client).
    """
    global _index_built
    _cache.clear()
    _sim_cache.clear()
    _bm25.clear()
    _titles_cache.clear()
    _index_built = False


# ---------------------------------------------------------------------------
# Accessors that work whether an item is an object or a dict.
# ---------------------------------------------------------------------------
def _attr(obj: Any, *names: str) -> Any:
    """Return the first present attribute/key from `names`, else None."""
    for name in names:
        if isinstance(obj, dict):
            if name in obj and obj[name] not in (None, ""):
                return obj[name]
        else:
            val = getattr(obj, name, None)
            if val not in (None, ""):
                return val
    return None


def _coerce_iterable(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


_CITATIONS_HEADER = "SOURCES (grounding passages from the technical manual):"


def _truncate(text: Any, limit: int = 300) -> str:
    t = " ".join(str(text).split())
    return t if len(t) <= limit else t[: limit - 3] + "..."


def _citation_header(c: Any, idx: int) -> str:
    """Build the '[n] <title> <url>/(source id)' prefix for one reference."""
    num = _attr(c, "citation_number") or idx
    title = _attr(c, "title", "name", "source_title", "document_title")
    url = _attr(c, "url", "uri", "link")
    source_id = _attr(c, "source_id", "source")
    bits = [f"  [{num}]"]
    if title:
        bits.append(str(title).strip())
    if url:
        bits.append(f"<{url}>")
    if not title and not url and source_id:
        bits.append(f"(source {source_id})")
    return " ".join(bits)


def _format_citations(result: Any) -> str:
    """Format grounding citations into a readable block for the model (fast path)."""
    raw = _attr(result, "references", "citations", "sources", "grounding", "footnotes")
    items = _coerce_iterable(raw)[: config.NOTEBOOKLM_MAX_CITATIONS]
    if not items:
        return ""

    lines: list[str] = []
    for i, c in enumerate(items, start=1):
        if isinstance(c, str):
            lines.append(f"  [{i}] {c.strip()}")
            continue
        snippet = _attr(c, "cited_text", "snippet", "text", "content", "quote", "excerpt")
        header = _citation_header(c, i)
        lines.append(f'{header}: "{_truncate(snippet)}"' if snippet else header)

    return f"{_CITATIONS_HEADER}\n" + "\n".join(lines) if lines else ""


def _dedupe_titles(raw_titles: list[str]) -> list[str]:
    """Normalize, truncate (80), drop blanks, de-dupe case-insensitively, cap 3."""
    out: list[str] = []
    seen: set[str] = set()
    for t in raw_titles:
        norm = " ".join(str(t).split()).strip()[:80]
        key = norm.lower()
        if not norm or key in seen:
            continue
        seen.add(key)
        out.append(norm)
        if len(out) >= 3:
            break
    return out


def extract_source_titles(result: Any) -> list[str]:
    """Human-readable source titles from a NotebookLM result's references.

    Best-effort and defensive — returns [] on anything missing/odd, never raises.
    Mirrors _format_citations' raw extraction + _citation_header's title keys, so
    the chip names the same sources the model was given.
    """
    try:
        raw = _attr(result, "references", "citations", "sources", "grounding", "footnotes")
        titles: list[str] = []
        for c in _coerce_iterable(raw):
            if isinstance(c, str):
                continue
            title = _attr(c, "title", "name", "source_title", "document_title")
            if title:
                titles.append(str(title))
        return _dedupe_titles(titles)
    except Exception:  # noqa: BLE001 - provenance is a bonus, never a failure path
        return []


def extract_local_titles(hits: list) -> list[str]:
    """Source titles from BM25 hits (L3 local path), de-duped; blanks dropped."""
    try:
        return _dedupe_titles([(getattr(ch, "title", "") or "") for _score, ch in hits])
    except Exception:  # noqa: BLE001
        return []


async def _format_citations_enriched(client: Any, notebook_id: str, result: Any) -> str:
    """Like _format_citations, but resolves fuller context per the SKILL.md.

    `cited_text` is often only a snippet/header; this fetches each cited source's
    indexed fulltext once and uses find_citation_context() for a larger passage.
    One get_fulltext RPC per distinct source (cached). Failures degrade to the snippet.
    """
    raw = _attr(result, "references", "citations", "sources")
    items = _coerce_iterable(raw)[: config.NOTEBOOKLM_MAX_CITATIONS]
    if not items:
        return ""

    fulltext_cache: dict[str, Any] = {}
    lines: list[str] = []
    for i, c in enumerate(items, start=1):
        if isinstance(c, str):
            lines.append(f"  [{i}] {c.strip()}")
            continue
        header = _citation_header(c, i)
        snippet = _attr(c, "cited_text", "snippet", "text")
        source_id = _attr(c, "source_id", "source")

        body = snippet
        if source_id and snippet:
            try:
                fulltext = fulltext_cache.get(source_id)
                if fulltext is None:
                    fulltext = await client.sources.get_fulltext(notebook_id, source_id)
                    fulltext_cache[source_id] = fulltext
                matches = fulltext.find_citation_context(str(snippet))
                if matches:
                    body = matches[0][0]  # surrounding context of the first match
            except Exception:  # noqa: BLE001 - enrichment is best-effort
                logger.debug("Citation context resolution failed for %s", source_id, exc_info=True)

        lines.append(f'{header}: "{_truncate(body, 400)}"' if body else header)

    return f"{_CITATIONS_HEADER}\n" + "\n".join(lines) if lines else ""


def _extract_answer(result: Any) -> str:
    answer = _attr(result, "answer", "text", "response", "content", "message")
    if answer is None:
        # Empty/whitespace-only or missing answer -> "" so the blank-answer
        # fallback fires. NEVER return str(result) (would leak the dataclass repr).
        logger.debug("AskResult had no usable answer field: %r", result)
        return ""
    return str(answer).strip()


# ===========================================================================
# L3 local-index answers (verbatim manual passages, grounded).
# ===========================================================================
_LOCAL_HEADER = (
    "DIRECT EXCERPTS FROM THE TECHNICAL MANUAL (verbatim; relay only the facts "
    "they contain and do not invent beyond them):"
)
_LOCAL_FALLBACK_PREFIX = (
    "The live manual service was momentarily unreachable, so here are the most "
    "relevant verbatim passages from the manual's indexed text. Relay the facts "
    "they contain; if they do not fully answer the question, tell the technician "
    "so and avoid guessing.\n\n"
)


def _format_local(hits: list) -> str:
    """Render BM25 hits as a grounded excerpt block for the model."""
    lines: list[str] = []
    for i, (_score, ch) in enumerate(hits, start=1):
        label = (ch.title or (f"source {ch.source_id}" if ch.source_id else "manual")).strip()
        lines.append(f'  [{i}] {label}: "{_truncate(ch.text, 500)}"')
    return f"{_LOCAL_HEADER}\n" + "\n".join(lines) if lines else ""


def _local_passages(query: str) -> str:
    """Top local manual passages for `query`, or "" if the index can't answer."""
    if not _bm25.ready:
        return ""
    hits = _bm25.search(query, k=config.NOTEBOOKLM_LOCAL_PASSAGES)
    return _format_local(hits) if hits else ""


# ===========================================================================
# Client management: warm singleton (preferred) + per-call fallback.
# ===========================================================================
def _open_client_ctx(keepalive: Optional[float] = None):
    """Return the from_storage async-context-manager (NOT awaited)."""
    kwargs: dict[str, Any] = {}
    if keepalive and keepalive > 0:
        kwargs["keepalive"] = keepalive
    if config.NOTEBOOKLM_STORAGE:
        return NotebookLMClient.from_storage(config.NOTEBOOKLM_STORAGE, **kwargs)
    if config.NOTEBOOKLM_PROFILE:
        return NotebookLMClient.from_storage(profile=config.NOTEBOOKLM_PROFILE, **kwargs)
    return NotebookLMClient.from_storage(**kwargs)


async def startup() -> None:
    """Open the warm singleton client on the current event loop (call in lifespan).

    Best-effort: on any failure we log and leave the singleton unset so queries
    transparently fall back to per-call clients.
    """
    global _warm_client, _warm_ctx, _prewarm_task, _index_task
    if NotebookLMClient is None or not config.NOTEBOOKLM_WARM_CLIENT:
        return
    if not config.ACTIVE_NOTEBOOK_ID:
        logger.info("No ACTIVE_NOTEBOOK_ID — skipping warm NotebookLM client.")
        return
    try:
        ctx = _open_client_ctx(keepalive=config.NOTEBOOKLM_KEEPALIVE_SECONDS or None)
        # Canonical idiom without the deprecated `await from_storage()`.
        _warm_client = await ctx.__aenter__()
        _warm_ctx = ctx
        logger.info(
            "NotebookLM warm client ready (keepalive=%ss).",
            config.NOTEBOOKLM_KEEPALIVE_SECONDS or "off",
        )
    except Exception:  # noqa: BLE001
        logger.exception("Warm NotebookLM client init failed; using per-call clients.")
        _warm_client = None
        _warm_ctx = None
        return

    if config.NOTEBOOKLM_PREWARM:
        _prewarm_task = asyncio.create_task(prewarm(), name="notebooklm-prewarm")
    if config.NOTEBOOKLM_LOCAL_INDEX:
        # Build the L3 local index in the background so it never delays boot.
        _index_task = asyncio.create_task(build_local_index(), name="notebooklm-index")


async def shutdown() -> None:
    """Close the warm client + cancel any pre-warm / index task (lifespan exit)."""
    global _warm_client, _warm_ctx, _prewarm_task, _index_task
    for attr in ("_prewarm_task", "_index_task"):
        task = globals().get(attr)
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            globals()[attr] = None
    if _warm_ctx is not None:
        try:
            await _warm_ctx.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001
            logger.debug("Warm client close error", exc_info=True)
    _warm_client = None
    _warm_ctx = None


async def prewarm() -> None:
    """Fire a throwaway query so the notebook's cold start happens up front.

    No-op unless the warm singleton is up (so it never triggers a stray network
    call in tests/loopback). Debounced so back-to-back connects don't spam it.
    """
    global _last_prewarm
    if _warm_client is None or not config.ACTIVE_NOTEBOOK_ID:
        return
    async with _prewarm_lock:
        now = time.monotonic()
        if now - _last_prewarm < _PREWARM_MIN_INTERVAL:
            return
        _last_prewarm = now
    try:
        await asyncio.wait_for(
            _query_and_format(_warm_client, config.NOTEBOOKLM_PREWARM_QUERY),
            timeout=config.NOTEBOOKLM_TIMEOUT_SECONDS,
        )
        logger.info("NotebookLM pre-warm complete.")
    except Exception:  # noqa: BLE001
        # A FAILED pre-warm must not suppress retries for the whole debounce
        # window — reset the timestamp so the next session can re-attempt (the
        # in-lock timestamp above still prevents a concurrent stampede).
        _last_prewarm = 0.0
        logger.warning("NotebookLM pre-warm failed (non-fatal); will retry.", exc_info=True)


async def list_notebooks() -> list[dict]:
    """List available notebooks (id + title) for the runtime manual picker."""
    if NotebookLMClient is None:
        raise RuntimeError(f"notebooklm-py not importable: {_IMPORT_ERROR}")

    async def _do(client: Any) -> list[dict]:
        notebooks = await client.notebooks.list()
        out: list[dict] = []
        for nb in _coerce_iterable(notebooks):
            nb_id = _attr(nb, "id", "notebook_id")
            if not nb_id:
                continue
            title = _attr(nb, "title", "name") or "(untitled)"
            out.append({"id": str(nb_id), "title": str(title)})
        return out

    if _warm_client is not None:
        return await _do(_warm_client)
    async with _open_client_ctx() as client:
        return await _do(client)


async def switch_notebook(notebook_id: str) -> None:
    """Atomically point the RAG service at a different notebook (runtime switch).

    Resets ALL notebook-scoped state in one place: cancels the in-flight index
    build, drops the L1/L2 caches + L3 index, re-arms the prewarm debounce, and
    (when a warm client exists) kicks off prewarm + index build for the new
    notebook in the background. Callers gate on no-active-sessions, so a live
    tool call can never straddle the swap.
    """
    global _index_task, _prewarm_task, _last_prewarm
    config.ACTIVE_NOTEBOOK_ID = notebook_id
    # Cancel BOTH in-flight background tasks — a stale old-notebook prewarm
    # would otherwise keep running (and pollute the fresh caches) post-switch.
    for task in (_index_task, _prewarm_task):
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
    _index_task = None
    _prewarm_task = None
    clear_cache()  # L1 + L2 + L3 (and _index_built) — answers are notebook-scoped
    _last_prewarm = 0.0  # the new notebook deserves an immediate cold-start warmup
    # Booted without an ACTIVE_NOTEBOOK_ID? startup() skipped the warm client —
    # open it NOW that a notebook exists, or the whole process would be stuck on
    # slow per-call clients with no prewarm and no local index.
    if _warm_client is None and config.NOTEBOOKLM_WARM_CLIENT and NotebookLMClient is not None:
        await startup()
        return  # startup() already kicked off prewarm + index build
    if _warm_client is not None:
        if config.NOTEBOOKLM_PREWARM:
            _prewarm_task = asyncio.create_task(prewarm(), name="notebooklm-prewarm")
        if config.NOTEBOOKLM_LOCAL_INDEX:
            _index_task = asyncio.create_task(build_local_index(), name="notebooklm-index")
    logger.info("Active notebook switched to %s", notebook_id)


async def build_local_index() -> None:
    """Fetch the notebook's source fulltext and (re)build the L3 BM25 index.

    Best-effort + background. Uses the warm client only (per-call clients would add
    latency + loop-affinity hazards). No-op when disabled, when there's no warm
    client/notebook, or once already built. One `get_fulltext` RPC per source.
    """
    global _index_built
    if (
        not config.NOTEBOOKLM_LOCAL_INDEX
        or _warm_client is None
        or not config.ACTIVE_NOTEBOOK_ID
        or _index_built
    ):
        return
    nb = config.ACTIVE_NOTEBOOK_ID
    try:
        sources = await _warm_client.sources.list(nb)
    except Exception:  # noqa: BLE001 - index is best-effort
        logger.warning("Local index: could not list sources (non-fatal).", exc_info=True)
        return

    documents: list[tuple[str, str, str]] = []
    for src in _coerce_iterable(sources):
        source_id = _attr(src, "source_id", "id", "sourceId")
        if not source_id:
            continue
        title = _attr(src, "title", "name", "source_title", "document_title") or ""
        try:
            fulltext = await _warm_client.sources.get_fulltext(nb, source_id)
        except Exception:  # noqa: BLE001
            logger.debug("Local index: get_fulltext failed for %s", source_id, exc_info=True)
            continue
        text = _attr(fulltext, "content", "text", "full_text", "fulltext", "body")
        if text is None:
            continue
        text = str(text).strip()
        if text:
            documents.append((str(source_id), str(title), text))

    if not documents:
        logger.info("Local index: no source fulltext available; L3 stays empty.")
        return
    try:
        count = _bm25.build(documents, max_chunks=config.NOTEBOOKLM_INDEX_MAX_CHUNKS)
        _index_built = True
        metrics.set_gauge("nb_local_index_chunks", count)
        logger.info(
            "Local manual index built: %d chunks from %d source(s).", count, len(documents)
        )
    except Exception:  # noqa: BLE001
        logger.warning("Local index build failed (non-fatal).", exc_info=True)


async def _query_and_format(client: Any, query: str) -> str:
    """Run one chat.ask and format answer + citations. Returns _NO_ANSWER if blank."""
    logger.info("NotebookLM query -> %r", query)
    result = await client.chat.ask(config.ACTIVE_NOTEBOOK_ID, query)
    answer = _extract_answer(result)
    if config.NOTEBOOKLM_RESOLVE_CITATIONS:
        citations = await _format_citations_enriched(client, config.ACTIVE_NOTEBOOK_ID, result)
    else:
        citations = _format_citations(result)
    final = (f"{answer}\n\n{citations}".strip() if citations else answer).strip()
    final = final or _NO_ANSWER
    # Record the source titles for the client provenance chip (side-channel only;
    # the answer string + caches are unchanged). Tied to a REAL answer: a blank /
    # no-answer result stores [] (popping any stale entry), so the chip can never
    # attest a source for an answer that wasn't actually grounded.
    _store_titles(_cache_key(query), extract_source_titles(result) if final != _NO_ANSWER else [])
    return final


async def _run(query: str) -> str:
    """Use the warm singleton if available, else a per-call client."""
    if _warm_client is not None:
        return await _query_and_format(_warm_client, query)
    async with _open_client_ctx() as client:
        return await _query_and_format(client, query)


# ===========================================================================
# Tiered-lookup helpers (metrics + cache writes + local fallback).
# ===========================================================================
def _record(tier: str, t0: float) -> None:
    """Record the outcome tier + end-to-end latency for one lookup.

    The timer base name is `nb_query` (no `_seconds`): the Prometheus exporter
    appends `_seconds_count/_sum/_max`, so this yields the conventional
    `nb_query_seconds_*` series rather than a doubled `_seconds_seconds_*`.
    """
    metrics.inc("nb_query_result_total", labels={"tier": tier})
    metrics.observe("nb_query", time.monotonic() - t0, labels={"tier": tier})


def _store(query: str, key: str, value: str) -> None:
    """Persist a genuine grounded answer in both the L1 exact + L2 similarity caches."""
    _cache.put(key, value)
    _sim_cache.put(query, value)


def _fallback(query: str, message: str, t0: float, reason: str) -> str:
    """On a NotebookLM failure, prefer grounded local passages over an apology.

    Returns the L3 fallback block when the local index can answer (and it's
    enabled), else the human-readable `message`. Records the outcome tier either way.
    """
    key = _cache_key(query)
    if config.NOTEBOOKLM_LOCAL_FALLBACK and _bm25.ready:
        hits = _bm25.search(query, k=config.NOTEBOOKLM_LOCAL_PASSAGES)
        block = _format_local(hits) if hits else ""
        if block:
            logger.info("NotebookLM %s -> serving L3 local fallback.", reason)
            # Provenance must name the LOCAL sources actually served, not a stale
            # L4 success from a prior ask of the same query.
            _store_titles(key, extract_local_titles(hits))
            _record("l3_fallback", t0)
            return _LOCAL_FALLBACK_PREFIX + block
    # A pure apology has NO grounding — clear any stale titles so the chip can't
    # falsely attest a source the spoken answer never had.
    _store_titles(key, [])
    _record(reason, t0)
    return message


# ===========================================================================
# Public entry point (called by the Gemini tool dispatch).
# ===========================================================================
async def fetch_technical_guidance(query: str) -> str:
    """Query the active NotebookLM notebook and return a Gemini-ready answer.

    ALWAYS returns a non-empty string (even on error) so the live tool-call
    exchange can complete. Tiered for speed + resilience:
        L1  exact-match cache         (instant)
        L2  near-duplicate cache      (instant; token-cosine paraphrase match)
        L3* local fast path           (optional; confident BM25 match, no network)
        L4  NotebookLM chat.ask       (authoritative, synthesized — the quality path)
        L3  local grounded fallback   (verbatim manual passages on L4 failure)
    """
    query = (query or "").strip()
    if not query:
        return "No query was provided to the technical manual lookup."

    metrics.inc("nb_query_total")
    t0 = time.monotonic()

    if NotebookLMClient is None:
        logger.error("notebooklm-py not importable: %s", _IMPORT_ERROR)
        _record("unavailable", t0)
        return (
            "The technical manual service is unavailable: the notebooklm-py "
            f"library failed to import ({_IMPORT_ERROR}). Inform the technician "
            "you cannot verify the value right now."
        )

    if not config.ACTIVE_NOTEBOOK_ID:
        logger.error("ACTIVE_NOTEBOOK_ID is not configured.")
        _record("unconfigured", t0)
        return (
            "The technical manual service is not configured (no active notebook "
            "id). Inform the technician you cannot verify the value right now."
        )

    # L1 — identical (normalized) queries are served instantly.
    key = _cache_key(query)
    cached = _cache.get(key)
    if cached is not None:
        logger.info("NotebookLM L1 cache HIT for %r", query)
        # Keep the title side-cache's LRU in lockstep with the answer cache, so a
        # frequently-hit answer never loses its provenance chip to eviction.
        if key in _titles_cache:
            _titles_cache.move_to_end(key)
        _record("l1", t0)
        return cached

    # L2 — a strong paraphrase of a question we already answered reuses its answer.
    sim = _sim_cache.get(query)
    if sim is not None:
        logger.info("NotebookLM L2 similarity HIT for %r", query)
        _cache.put(key, sim)  # promote the exact form for an instant L1 next time
        _record("l2", t0)
        return sim

    # L3 fast path (opt-in) — answer locally when the manual matches very strongly.
    if config.NOTEBOOKLM_LOCAL_FAST_PATH and _bm25.ready:
        hits = _bm25.search(query, k=config.NOTEBOOKLM_LOCAL_PASSAGES)
        if hits and hits[0][0] >= config.NOTEBOOKLM_LOCAL_FAST_PATH_MIN_SCORE:
            block = _format_local(hits)
            if block:
                logger.info(
                    "NotebookLM L3 fast-path HIT (score=%.1f) for %r", hits[0][0], query
                )
                _store(query, key, block)
                _store_titles(key, extract_local_titles(hits))
                _record("l3_fast", t0)
                return block

    # L4 — the authoritative NotebookLM lookup. The semaphore (inside wait_for so
    # queue-wait + ask share the one timeout) caps concurrent live round-trips, so
    # a multi-lookup toolCall frame can't fan out unbounded asks. A call that waits
    # too long for a slot simply times out into the L3 grounded fallback.
    async def _bounded_lookup() -> str:
        async with _lookup_semaphore():
            return await _run(query)

    try:
        result = await asyncio.wait_for(_bounded_lookup(), timeout=config.NOTEBOOKLM_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("NotebookLM query timed out after %ss", config.NOTEBOOKLM_TIMEOUT_SECONDS)
        return _fallback(
            query,
            "The technical manual lookup timed out. Tell the technician the "
            "manual is slow to respond and offer to retry.",
            t0,
            "timeout",
        )
    # Order matters: NotebookNotFoundError and RateLimitError subclass RPCError,
    # so they must be caught before the generic RPCError clause.
    except RateLimitError:
        logger.warning("NotebookLM rate-limited")
        return _fallback(
            query,
            "The technical manual is rate-limited right now. Tell the technician "
            "to wait a few moments and you'll try again.",
            t0,
            "rate_limit",
        )
    except NotebookNotFoundError:
        logger.error("Notebook not found: %s", config.ACTIVE_NOTEBOOK_ID)
        return _fallback(
            query,
            "The configured notebook could not be found. Tell the technician the "
            "knowledge base is misconfigured (check ACTIVE_NOTEBOOK_ID).",
            t0,
            "not_found",
        )
    except AuthError as exc:
        logger.error("NotebookLM auth error: %s", exc)
        return _fallback(
            query,
            "Could not authenticate to NotebookLM (session expired). Re-run "
            "'notebooklm login' (or --browser-cookies chrome) on the server. Tell "
            "the technician you cannot reach the manual right now.",
            t0,
            "auth",
        )
    except FileNotFoundError as exc:
        logger.error("NotebookLM auth/storage missing: %s", exc)
        return _fallback(
            query,
            "Could not authenticate to NotebookLM (no stored session). Run "
            "'notebooklm login --browser-cookies chrome' on the server. Tell "
            "the technician you cannot reach the manual right now.",
            t0,
            "auth",
        )
    except RPCError as exc:
        logger.exception("NotebookLM RPC error")
        return _fallback(
            query,
            f"The technical manual service had an error ({exc}). Tell the "
            "technician you cannot verify that value right now and avoid guessing.",
            t0,
            "rpc",
        )
    except NotebookLMError as exc:
        # Domain errors that are NOT RPCError subclasses (e.g. ChatError on the
        # post-ask round-trip, NetworkError on transport faults).
        logger.exception("NotebookLM domain error")
        return _fallback(
            query,
            f"The technical manual service is unreachable ({type(exc).__name__}). "
            "Tell the technician you cannot reach the manual right now.",
            t0,
            "domain",
        )
    except Exception as exc:  # noqa: BLE001 - must never break the live session
        logger.exception("NotebookLM query failed")
        return _fallback(
            query,
            f"The technical manual lookup failed ({type(exc).__name__}: {exc}). "
            "Tell the technician you cannot verify that specific value right now "
            "and avoid guessing.",
            t0,
            "error",
        )

    # Cache only genuine grounded answers — never the no-answer fallback (it may
    # become answerable later) and never the error strings (they return above).
    if result and result != _NO_ANSWER:
        _store(query, key, result)
    _record("l4", t0)
    return result


# Manual smoke test:  python -m services.knowledge "torque spec for M8 bolts"
if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)
    q = " ".join(sys.argv[1:]) or "Give me a summary of the manual."
    print(asyncio.run(fetch_technical_guidance(q)))
