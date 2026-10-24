"""Shared path setup for the project-level QA suites."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "stepwise" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
