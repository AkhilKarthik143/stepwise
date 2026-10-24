"""
Create a dummy NotebookLM notebook seeded with a fake equipment service manual,
so you can exercise the RAG tool end-to-end without a real notebook.

Prereqs:
    1. Install deps:   pip install -r requirements.txt
    2. Authenticate:   notebooklm login --browser-cookies chrome

Run (from the project root, with the venv active):
    python scripts/bootstrap_notebook.py

It prints the new notebook id — copy it into .env as ACTIVE_NOTEBOOK_ID, then
verify with:
    python scripts/test_notebook.py "What is the torque spec for the M8 head bolts?"
"""
from __future__ import annotations

import asyncio
import sys

# Force UTF-8 stdout so the manual's Unicode (e.g. "N·m") never crashes a legacy
# Windows console code page (cp1255 etc.). App traffic is UTF-8 JSON, unaffected.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Allow running as `python scripts/bootstrap_notebook.py` from the repo root.
sys.path.insert(0, ".")

from notebooklm import NotebookLMClient  # noqa: E402

DUMMY_MANUAL = """\
XR-200 INDUSTRIAL PUMP — FIELD SERVICE MANUAL (EXCERPT)

SECTION 4 — FASTENER TORQUE SPECIFICATIONS
- Pump head bolts (M8, grade 8.8): 25 N·m (18.4 ft·lb), tightened in a star
  pattern across two passes (first pass 12 N·m).
- Impeller retaining nut (M12): 60 N·m (44 ft·lb). Apply medium-strength
  threadlocker.
- Casing drain plug (G1/4): 15 N·m (11 ft·lb). Do NOT overtighten — alloy body.

SECTION 7 — ERROR CODES
- E-12  Low inlet pressure. Check suction strainer and prime the pump. Clear by
  cycling power after restoring prime.
- E-45  Motor over-temperature. Stop the pump, allow 20 minutes to cool, verify
  cooling-fan rotation and ambient airflow. Reset by holding RESET for 5 s.
- E-71  Seal-leak detected. Inspect the mechanical seal cartridge; replace if the
  weep hole shows continuous flow. Reset is automatic once the leak sensor dries.

SECTION 9 — MECHANICAL SEAL REPLACEMENT (SUMMARY)
1. Lock out / tag out and depressurize. Confirm 0 bar at the casing gauge.
2. Remove the four M8 head bolts (see Section 4) and lift the pump head.
3. Extract the seal cartridge; note the orientation arrow faces the impeller.
4. Seat the new cartridge by hand only — never press on the carbon face.
5. Reassemble; torque head bolts to 25 N·m in the specified star pattern.
"""


async def main() -> None:
    async with NotebookLMClient.from_storage() as client:
        print("Creating notebook 'AR Technician Test'…")
        nb = await client.notebooks.create("AR Technician Test")
        nb_id = getattr(nb, "id", None) or getattr(nb, "notebook_id", None)
        print(f"  notebook id = {nb_id}")

        print("Adding dummy service-manual source (this can take ~30-60s)…")
        await client.sources.add_text(
            nb_id, "XR-200 Field Service Manual", DUMMY_MANUAL, wait=True
        )
        print("  source added and processed.")

        print("\nSanity check — asking the notebook a question:")
        result = await client.chat.ask(nb_id, "What is the torque spec for the M8 head bolts?")
        print("  ANSWER:", getattr(result, "answer", result))

        print("\n" + "=" * 64)
        print(f"DONE. Set this in your .env:\n    ACTIVE_NOTEBOOK_ID={nb_id}")
        print("=" * 64)


if __name__ == "__main__":
    asyncio.run(main())
