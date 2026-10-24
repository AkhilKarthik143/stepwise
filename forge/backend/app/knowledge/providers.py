"""Moss adapter with an explicit local-document fallback."""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from typing import Any


@dataclass
class RetrievalResult:
    status: str
    passages: list[dict[str, Any]]
    provider: str


class LocalDocumentProvider:
    def __init__(self, catalog) -> None:
        self.catalog = catalog

    async def query(self, query: str, *, machine_model: str | None = None, top_k: int = 3) -> RetrievalResult:
        q = (query or "").lower()
        passages: list[dict[str, Any]] = []
        for key, procedure in self.catalog.procedures.items():
            text = " ".join([procedure.get("title", "")] + [s.get("text", "") for s in procedure.get("steps", [])])
            if any(token in text.lower() for token in q.split() if len(token) > 2):
                passages.append({"id": key, "text": text[:700], "title": procedure.get("title"), "section": "procedure", "machine_model": machine_model or "PL45LM Turn-Mill", "matched_component_ids": []})
        if not passages:
            passages = [{"id": "catalog-safety", "text": "FORGE only advances safety checklists after explicit technician confirmation.", "title": "FORGE safety policy", "section": "safety", "machine_model": machine_model or "PL45LM Turn-Mill", "matched_component_ids": []}]
        return RetrievalResult(status="local_fallback", passages=passages[:top_k], provider="local")


class MossProvider:
    def __init__(self, project_id: str, project_key: str, index_name: str, local: LocalDocumentProvider) -> None:
        self.project_id = project_id
        self.project_key = project_key
        self.index_name = index_name
        self.local = local
        self.client = None

    async def query(self, query: str, *, machine_model: str | None = None, top_k: int = 3) -> RetrievalResult:
        if not importlib.util.find_spec("moss"):
            return await self.local.query(query, machine_model=machine_model, top_k=top_k)
        try:
            from moss import MossClient, QueryOptions

            if self.client is None:
                self.client = MossClient(self.project_id, self.project_key)
            await self.client.load_index(self.index_name)
            results = await self.client.query(self.index_name, query, QueryOptions(top_k=top_k))
            passages = []
            for doc in results.docs:
                metadata = getattr(doc, "metadata", {}) or {}
                passages.append({"id": getattr(doc, "id", ""), "text": getattr(doc, "text", ""), "score": getattr(doc, "score", 0), "title": metadata.get("title", "Moss document"), "section": metadata.get("section", "unknown"), "machine_model": metadata.get("machine_model", machine_model), "matched_component_ids": metadata.get("matched_component_ids", [])})
            return RetrievalResult(status="moss_verified", passages=passages, provider="moss")
        except Exception:
            return await self.local.query(query, machine_model=machine_model, top_k=top_k)
