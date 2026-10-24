"""pytest bootstrap: make the project root importable as `config`, `services`,
`main`, and isolate module-global state between tests."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))


@pytest.fixture(autouse=True)
def _isolate_global_state(monkeypatch):
    """Reset module-global state before each test so nothing leaks across tests:
    the L1/L2 answer caches + L3 local index, the per-IP rate-limiter buckets, the
    session set, and the in-process metrics registry.

    Also neutralizes auth by default: config reads `.env` at import, and a real
    deployment `.env` now carries API_AUTH_TOKEN + AUTH_USERS_JSON — without this
    reset every /offer, /ice-config, and /notebooks test would 401 on the ambient
    token. Tests that exercise auth (tests/test_auth.py) opt back in explicitly."""
    from services import knowledge
    from services.metrics import metrics

    knowledge.clear_cache()
    metrics.reset()
    import config
    import main

    monkeypatch.setattr(config, "API_AUTH_TOKEN", "", raising=False)
    monkeypatch.setattr(config, "AUTH_USERS", {}, raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False, raising=False)
    main._rate_buckets.clear()
    main._sessions.clear()
    yield
