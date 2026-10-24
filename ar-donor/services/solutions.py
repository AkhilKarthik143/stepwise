"""Solution Memory — per-company database of solved cases.

Every company (tenant) gets its OWN SQLite database + photo directory under
DATA_DIR/tenants/<company>/ — physical isolation, easy per-company backup or
deletion, and no cross-tenant query can even be expressed. A solved case stores
the problem, the equipment, the fix, optional tags, and an optional photo
(stored as a file next to the DB, not as a base64 blob in the DB).

Search (v1) is case-insensitive keyword matching over title/problem/equipment/
fix/tags — "have we solved this before?". A semantic upgrade can slot in later
without changing the API.

SQLite is used per-tenant deliberately: one small file per company on the
volume-mounted DATA_DIR, no DB server to run, and WAL mode handles this app's
concurrency (a handful of writers per company).
"""
from __future__ import annotations

import base64
import os
import re
import sqlite3
import time
import uuid

import config

_MAX_TEXT = 8000
_MAX_TAGS = 500
_MAX_PHOTO_BYTES = 8 * 1024 * 1024  # decoded photo cap (8 MB)


def _slug(company: str) -> str:
    c = (company or "default").strip().lower()
    c = "".join(ch for ch in c if ch.isalnum() or ch in "-_")
    return c or "default"


def _tenant_dir(company: str) -> str:
    d = os.path.join(config.DATA_DIR, "tenants", _slug(company))
    os.makedirs(os.path.join(d, "photos"), exist_ok=True)
    return d


def _db(company: str) -> sqlite3.Connection:
    conn = sqlite3.connect(os.path.join(_tenant_dir(company), "solutions.db"))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS solutions (
            id TEXT PRIMARY KEY,
            ts REAL NOT NULL,
            author TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL,
            equipment TEXT NOT NULL DEFAULT '',
            problem TEXT NOT NULL DEFAULT '',
            fix TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '',
            photo TEXT NOT NULL DEFAULT ''
        )"""
    )
    return conn


def _clean(s, cap=_MAX_TEXT) -> str:
    return str(s or "").strip()[:cap]


def save_solution(
    company: str,
    author: str,
    title: str,
    equipment: str = "",
    problem: str = "",
    fix: str = "",
    tags: str = "",
    photo_b64: str = "",
) -> str:
    """Persist one solved case for `company`; returns its id. The photo (raw
    base64 or data URL) is written as a JPEG file in the tenant's photo dir."""
    title = _clean(title, 300)
    if not title:
        raise ValueError("A title is required.")
    sid = uuid.uuid4().hex[:12]
    photo_name = ""
    if photo_b64 and photo_b64.strip():
        raw = photo_b64.strip()
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[1] if "," in raw else ""
        try:
            data = base64.b64decode(raw, validate=False)
        except Exception as e:  # noqa: BLE001
            raise ValueError("Could not decode the photo.") from e
        if data:
            if len(data) > _MAX_PHOTO_BYTES:
                raise ValueError("Photo too large.")
            photo_name = f"{sid}.jpg"
            with open(os.path.join(_tenant_dir(company), "photos", photo_name), "wb") as f:
                f.write(data)
    conn = _db(company)
    try:
        with conn:
            conn.execute(
                "INSERT INTO solutions (id, ts, author, title, equipment, problem, fix, tags, photo)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    sid,
                    time.time(),
                    _clean(author, 200),
                    title,
                    _clean(equipment, 500),
                    _clean(problem),
                    _clean(fix),
                    _clean(tags, _MAX_TAGS),
                    photo_name,
                ),
            )
    finally:
        conn.close()
    return sid


def _row_to_dict(row, company: str, with_photo: bool) -> dict:
    d = {
        "id": row[0],
        "ts": row[1],
        "author": row[2],
        "title": row[3],
        "equipment": row[4],
        "problem": row[5],
        "fix": row[6],
        "tags": row[7],
        "hasPhoto": bool(row[8]),
    }
    if with_photo and row[8]:
        path = os.path.join(_tenant_dir(company), "photos", os.path.basename(row[8]))
        try:
            with open(path, "rb") as f:
                d["photo"] = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
        except OSError:
            d["hasPhoto"] = False
    return d


_COLS = "id, ts, author, title, equipment, problem, fix, tags, photo"


def search_solutions(company: str, query: str = "", limit: int = 20) -> list[dict]:
    """Keyword search over the company's solved cases (newest first). An empty
    query lists the most recent. Every word must match at least one text field."""
    limit = max(1, min(int(limit or 20), 50))
    conn = _db(company)
    try:
        words = [w for w in re.split(r"\s+", (query or "").strip()) if w][:8]
        sql = f"SELECT {_COLS} FROM solutions"
        params: list = []
        if words:
            clauses = []
            for w in words:
                like = f"%{w}%"
                clauses.append(
                    "(title LIKE ? OR equipment LIKE ? OR problem LIKE ? OR fix LIKE ? OR tags LIKE ?)"
                )
                params += [like] * 5
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return [_row_to_dict(r, company, with_photo=False) for r in rows]


def get_solution(company: str, sid: str) -> dict | None:
    """One case with its photo inlined as a data URL (or None if not found)."""
    sid = "".join(c for c in str(sid or "") if c.isalnum())[:32]
    if not sid:
        return None
    conn = _db(company)
    try:
        row = conn.execute(
            f"SELECT {_COLS} FROM solutions WHERE id = ?", (sid,)
        ).fetchone()
    finally:
        conn.close()
    return _row_to_dict(row, company, with_photo=True) if row else None
