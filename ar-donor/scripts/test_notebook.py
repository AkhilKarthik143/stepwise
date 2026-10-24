"""
Quick check that the RAG tool works against your configured notebook.

Run:
    python scripts/test_notebook.py "What does error code E-45 mean?"

Requires .env to contain a valid ACTIVE_NOTEBOOK_ID and a completed
`notebooklm login`.
"""
from __future__ import annotations

import asyncio
import sys

# Windows consoles default to a legacy code page (e.g. cp1255) that cannot encode
# some Unicode an answer may contain; force UTF-8 so this diagnostic never crashes
# on output. (The app itself ships UTF-8 JSON over the websocket — unaffected.)
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, ".")

from services.knowledge import fetch_technical_guidance  # noqa: E402


async def main() -> None:
    query = " ".join(sys.argv[1:]) or "Summarize the service manual."
    print(f"QUERY: {query}\n")
    print(await fetch_technical_guidance(query))


if __name__ == "__main__":
    asyncio.run(main())
