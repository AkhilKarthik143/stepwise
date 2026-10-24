"""
Local retrieval primitives (v2 Speed L2 / L3) — pure Python, zero ML deps.
============================================================================

NotebookLM gives authoritative, synthesized answers but is never sub-second on a
novel query (and has a ~40s cold start). The L1 exact cache in services.knowledge
only helps *identical* repeat questions. This module adds two cheaper tiers that
run entirely in-process on the manual's own text:

  L2  SimilarityCache  — a near-duplicate answer cache. Two questions that are
      lexically almost the same ("torque for the M8 head bolts?" vs "what's the
      M8 head bolt torque spec") should not both pay the NotebookLM round-trip.
      We keep a small TTL+LRU of (query, answer) and serve a cached answer when a
      new query's token-cosine similarity to a stored one clears a high threshold.
      No embeddings: a bag-of-words cosine is enough to catch paraphrases of the
      SAME question, and a high threshold keeps it from confusing *different* ones.

  L3  Bm25Index — a local lexical index over the notebook's source fulltext
      (fetched once via notebooklm `sources.get_fulltext`, chunked). Two uses:
        * Resilience fallback (default ON): when NotebookLM times out / is rate-
          limited / errors, return the top matching VERBATIM manual passages as a
          grounded block instead of an apology. Still hallucination-free — it is
          the manual's own words, clearly labelled as direct excerpts.
        * Optional fast path (default OFF): when a query matches indexed passages
          very strongly, answer locally and skip the slow call. Off by default so
          the quality path (NotebookLM's synthesis) stays primary.

Everything here is synchronous and CPU-only; a service manual chunks to a few
hundred entries, so a full BM25 scan is microseconds. Callers run it on the app's
single asyncio loop. No locks needed (one loop = one thread).
"""
from __future__ import annotations

import math
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Iterable, Optional

# Tiny stopword set — just the highest-frequency function words. Kept small on
# purpose: domain terms, part numbers, and codes (m8, e45, 25) must survive.
_STOPWORDS = frozenset(
    """
    a an the of to in on at for and or but if is are was were be been being it its
    this that these those with without from by as into over under out up down off
    do does did how what when where which who whom whose why your you i we they them
    me my our their his her he she me's please tell give show find me about can could
    would should will shall may might must have has had get got need want
    """.split()
)

# `[^\W_]` = any Unicode word character except underscore (letters + digits in
# every script). NOT ASCII-only [a-z0-9] — that silently dropped Cyrillic/CJK and
# mangled accented Latin, so non-English service manuals indexed to nothing.
_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    """Lowercase + split into alphanumeric tokens (Unicode-aware), dropping stopwords.

    Numbers and alphanumerics are KEPT (m8, e45, 25, 200) — they carry the
    technical meaning. Single-char pure-alpha tokens are dropped as noise; single
    digits are kept (a torque/time value can be one digit). Non-ASCII scripts
    (e.g. Cyrillic, CJK, accented Latin) survive so localized manuals index.
    """
    out: list[str] = []
    for tok in _TOKEN_RE.findall((text or "").lower()):
        if tok in _STOPWORDS:
            continue
        if len(tok) == 1 and tok.isalpha():
            continue
        out.append(tok)
    return out


def _counts(tokens: Iterable[str]) -> dict[str, int]:
    c: dict[str, int] = {}
    for t in tokens:
        c[t] = c.get(t, 0) + 1
    return c


def cosine(a: dict[str, int], b: dict[str, int]) -> float:
    """Cosine similarity of two token-frequency maps. 0.0 when either is empty."""
    if not a or not b:
        return 0.0
    # Iterate the smaller map for the dot product.
    small, large = (a, b) if len(a) <= len(b) else (b, a)
    dot = 0.0
    for tok, n in small.items():
        m = large.get(tok)
        if m:
            dot += n * m
    if dot == 0.0:
        return 0.0
    na = math.sqrt(sum(n * n for n in a.values()))
    nb = math.sqrt(sum(n * n for n in b.values()))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


# ===========================================================================
# L2 — near-duplicate answer cache (token-cosine over prior queries).
# ===========================================================================
@dataclass
class _SimEntry:
    counts: dict[str, int]
    answer: str
    expiry: float


class SimilarityCache:
    """Serve a stored answer when a new query is ~the same question as a past one.

    A high threshold (default 0.86) means only strong paraphrases of the SAME
    question hit; genuinely different questions fall through to the live lookup.
    """

    def __init__(self, maxsize: int, ttl: float, threshold: float) -> None:
        self._maxsize = max(0, maxsize)
        self._ttl = ttl
        self._threshold = threshold
        self._data: "OrderedDict[str, _SimEntry]" = OrderedDict()

    @property
    def enabled(self) -> bool:
        return self._maxsize > 0 and self._ttl > 0 and self._threshold > 0

    def _purge_expired(self, now: float) -> None:
        dead = [k for k, e in self._data.items() if now >= e.expiry]
        for k in dead:
            self._data.pop(k, None)

    def get(self, query: str) -> Optional[str]:
        """Return the answer of the most-similar fresh entry above threshold."""
        if not self.enabled:
            return None
        now = time.monotonic()
        self._purge_expired(now)
        q = _counts(tokenize(query))
        if not q:
            return None
        best_key: Optional[str] = None
        best_score = 0.0
        for key, entry in self._data.items():
            score = cosine(q, entry.counts)
            if score > best_score:
                best_score, best_key = score, key
        if best_key is not None and best_score >= self._threshold:
            self._data.move_to_end(best_key)  # LRU touch
            return self._data[best_key].answer
        return None

    def put(self, query: str, answer: str) -> None:
        if not self.enabled or not answer:
            return
        key = " ".join(tokenize(query))
        if not key:
            return
        self._data[key] = _SimEntry(
            counts=_counts(key.split()),
            answer=answer,
            expiry=time.monotonic() + self._ttl,
        )
        self._data.move_to_end(key)
        while len(self._data) > self._maxsize:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()


# ===========================================================================
# Chunking — split a long source fulltext into overlapping word windows.
# ===========================================================================
def chunk_text(text: str, max_words: int = 180, overlap: int = 40) -> list[str]:
    """Greedy overlapping word windows. Overlap keeps a fact from being split
    across a boundary so BM25 can still match it."""
    words = (text or "").split()
    if not words:
        return []
    if len(words) <= max_words:
        return [" ".join(words)]
    step = max(1, max_words - max(0, overlap))
    chunks: list[str] = []
    for start in range(0, len(words), step):
        window = words[start : start + max_words]
        if window:
            chunks.append(" ".join(window))
        if start + max_words >= len(words):
            break
    return chunks


# ===========================================================================
# L3 — BM25 Okapi over local manual chunks.
# ===========================================================================
@dataclass
class Chunk:
    source_id: str
    title: str
    text: str
    tokens: list[str] = field(default_factory=list)
    length: int = 0


class Bm25Index:
    """A small, dependency-free BM25 retriever over manual text chunks.

    Build once from the notebook's source fulltext; query as a fast local tier.
    `ready` is False until at least one chunk is indexed.
    """

    def __init__(self, k1: float = 1.5, b: float = 0.75) -> None:
        self._k1 = k1
        self._b = b
        self._chunks: list[Chunk] = []
        self._df: dict[str, int] = {}
        self._idf: dict[str, float] = {}
        self._avgdl = 0.0

    @property
    def ready(self) -> bool:
        return bool(self._chunks)

    @property
    def size(self) -> int:
        return len(self._chunks)

    def build(self, documents: Iterable[tuple[str, str, str]], max_chunks: int) -> int:
        """(Re)build the index. documents = iterable of (source_id, title, fulltext).

        Returns the number of chunks indexed. `max_chunks` caps total chunks to
        bound memory + per-query scan time; when it bites, chunks are taken
        ROUND-ROBIN across sources so a large first source can't starve later ones
        (first-come truncation would make trailing manuals silently unsearchable).
        max_chunks <= 0 means no cap (config clamps the knob to >= 1, so the
        production path always passes a real cap).
        """
        # Chunk every document first, keeping per-source groups.
        per_doc: list[list[Chunk]] = []
        for source_id, title, fulltext in documents:
            doc_chunks: list[Chunk] = []
            for piece in chunk_text(fulltext):
                toks = tokenize(piece)
                if not toks:
                    continue
                doc_chunks.append(
                    Chunk(
                        source_id=str(source_id or ""),
                        title=str(title or ""),
                        text=piece,
                        tokens=toks,
                        length=len(toks),
                    )
                )
            if doc_chunks:
                per_doc.append(doc_chunks)

        cap = max_chunks if max_chunks and max_chunks > 0 else None
        chunks: list[Chunk] = []
        if cap is None:
            for dc in per_doc:
                chunks.extend(dc)
        else:
            # Interleave: take chunk[i] from each source in turn until the cap.
            i = 0
            while len(chunks) < cap:
                progressed = False
                for dc in per_doc:
                    if i < len(dc):
                        chunks.append(dc[i])
                        progressed = True
                        if len(chunks) >= cap:
                            break
                if not progressed:
                    break
                i += 1

        df: dict[str, int] = {}
        for ch in chunks:
            for tok in set(ch.tokens):
                df[tok] = df.get(tok, 0) + 1

        n = len(chunks)
        idf: dict[str, float] = {}
        for tok, freq in df.items():
            # BM25+ idf — always positive, avoids the classic negative-idf for
            # terms present in > half the chunks.
            idf[tok] = math.log(1 + (n - freq + 0.5) / (freq + 0.5))

        self._chunks = chunks
        self._df = df
        self._idf = idf
        self._avgdl = (sum(c.length for c in chunks) / n) if n else 0.0
        return n

    def clear(self) -> None:
        self._chunks = []
        self._df = {}
        self._idf = {}
        self._avgdl = 0.0

    def _score(self, q_tokens: list[str], ch: Chunk) -> float:
        if not ch.length or self._avgdl == 0.0:
            return 0.0
        tf: dict[str, int] = {}
        for t in ch.tokens:
            tf[t] = tf.get(t, 0) + 1
        score = 0.0
        denom_base = self._k1 * (1 - self._b + self._b * (ch.length / self._avgdl))
        for term in q_tokens:
            f = tf.get(term)
            if not f:
                continue
            idf = self._idf.get(term, 0.0)
            score += idf * (f * (self._k1 + 1)) / (f + denom_base)
        return score

    def search(self, query: str, k: int = 3) -> list[tuple[float, Chunk]]:
        """Top-k (score, chunk) for a query, best first. Empty when not ready."""
        if not self.ready or k <= 0:
            return []
        q_tokens = tokenize(query)
        if not q_tokens:
            return []
        scored = [
            (self._score(q_tokens, ch), ch) for ch in self._chunks
        ]
        scored = [s for s in scored if s[0] > 0.0]
        scored.sort(key=lambda s: s[0], reverse=True)
        return scored[:k]
