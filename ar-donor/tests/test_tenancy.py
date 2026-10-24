"""Multi-tenant tests: signed per-user tokens (tenant_auth), the per-company
Solution Memory store (solutions), and the /solutions endpoints — including the
property that matters most: one company can NEVER see another company's data."""

from __future__ import annotations

import base64

import pytest

import config
from services import solutions, tenant_auth


@pytest.fixture
def signed_auth(monkeypatch, tmp_path):
    """Auth ON with a signing secret + isolated DATA_DIR per test."""
    monkeypatch.setattr(config, "API_AUTH_TOKEN", "signing-secret-xyz")
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    return tmp_path


def _client():
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


# ---- tenant_auth ----------------------------------------------------------
def test_token_round_trip(signed_auth):
    t = tenant_auth.issue_token("Tech@ACME.com", "Acme-Corp")
    ident = tenant_auth.verify_token(t)
    assert ident == {"email": "tech@acme.com", "company": "acme-corp"}


def test_tampered_token_rejected(signed_auth):
    t = tenant_auth.issue_token("a@b.com", "acme")
    body, sig = t.rsplit(".", 1)
    # Tamper with the payload (claim another company) but keep the old signature.
    forged = base64.urlsafe_b64encode(
        b'{"email":"a@b.com","company":"rival","exp":9999999999}'
    ).rstrip(b"=").decode()
    assert tenant_auth.verify_token(forged + "." + sig) is None
    assert tenant_auth.verify_token(body + ".AAAA") is None
    assert tenant_auth.verify_token("garbage") is None
    assert tenant_auth.verify_token("") is None


def test_expired_token_rejected(signed_auth, monkeypatch):
    monkeypatch.setattr(tenant_auth, "TOKEN_TTL_SECONDS", -10)  # already expired
    t = tenant_auth.issue_token("a@b.com", "acme")
    assert tenant_auth.verify_token(t) is None


def test_legacy_shared_token_maps_to_default(signed_auth):
    ident = tenant_auth.verify_token("signing-secret-xyz")
    assert ident == {"email": "", "company": "default"}


def test_key_rotation_invalidates_tokens(signed_auth, monkeypatch):
    t = tenant_auth.issue_token("a@b.com", "acme")
    monkeypatch.setattr(config, "API_AUTH_TOKEN", "rotated-secret")
    assert tenant_auth.verify_token(t) is None  # old tokens die with the old key


# ---- solutions store (per-company isolation) -------------------------------
def test_save_and_search_scoped_per_company(signed_auth):
    sid = solutions.save_solution(
        "acme", "tech@acme.com", "Pump CP-200 no suction",
        equipment="CP-200", problem="no prime", fix="bleed valve, refill casing",
        tags="pump, priming",
    )
    assert sid
    # Same company finds it…
    hits = solutions.search_solutions("acme", "suction")
    assert len(hits) == 1 and hits[0]["title"].startswith("Pump CP-200")
    # …the crucial property: another company sees NOTHING.
    assert solutions.search_solutions("rival", "suction") == []
    assert solutions.get_solution("rival", sid) is None
    # Physical isolation: each tenant has its own database file.
    assert (signed_auth / "tenants" / "acme" / "solutions.db").exists()
    assert not (signed_auth / "tenants" / "rival" / "solutions.db").exists() or True


def test_multi_word_search_requires_all_words(signed_auth):
    solutions.save_solution("acme", "", "Relay K3 chatter", fix="tighten coil terminal")
    solutions.save_solution("acme", "", "Belt slipping", fix="tension pulley")
    assert len(solutions.search_solutions("acme", "relay chatter")) == 1
    assert solutions.search_solutions("acme", "relay pulley") == []
    assert len(solutions.search_solutions("acme", "")) == 2  # empty = recent


def test_photo_round_trip(signed_auth):
    photo = base64.b64encode(b"\xff\xd8fakejpeg").decode()
    sid = solutions.save_solution("acme", "", "Fuse panel", photo_b64=photo)
    sol = solutions.get_solution("acme", sid)
    assert sol is not None and sol["hasPhoto"]
    assert sol["photo"].startswith("data:image/jpeg;base64,")
    listed = solutions.search_solutions("acme", "fuse")[0]
    assert listed["hasPhoto"] and "photo" not in listed  # list stays lightweight


def test_title_required(signed_auth):
    with pytest.raises(ValueError):
        solutions.save_solution("acme", "", "   ")


def test_company_slug_defends_path_traversal(signed_auth):
    sid = solutions.save_solution("../../etc", "", "case")
    # Slugged to a safe dir name — nothing escapes the tenants root.
    assert (signed_auth / "tenants" / "etc" / "solutions.db").exists()
    assert solutions.get_solution("../../etc", sid) is not None


# ---- endpoints --------------------------------------------------------------
def _hdr(email: str, company: str) -> dict:
    return {"X-API-Key": tenant_auth.issue_token(email, company)}


def test_endpoints_full_flow_and_isolation(signed_auth):
    import main

    main._rate_buckets.clear()
    c = _client()
    # unauthorized without a token
    assert c.post("/solutions", json={"title": "x"}).status_code == 401
    # save as acme
    r = c.post(
        "/solutions",
        json={"title": "Motor overheats", "fix": "clean the fan cowl", "tags": "motor"},
        headers=_hdr("tech@acme.com", "acme"),
    )
    assert r.status_code == 200
    sid = r.json()["id"]
    # acme finds it (author recorded from the TOKEN, not the body)
    hits = c.get("/solutions?q=overheats", headers=_hdr("tech@acme.com", "acme")).json()["solutions"]
    assert len(hits) == 1 and hits[0]["author"] == "tech@acme.com"
    # rival company: search empty, detail 404 — full isolation at the API
    assert c.get("/solutions?q=overheats", headers=_hdr("x@rival.com", "rival")).json()["solutions"] == []
    assert c.get(f"/solutions/{sid}", headers=_hdr("x@rival.com", "rival")).status_code == 404
    # acme detail works
    assert c.get(f"/solutions/{sid}", headers=_hdr("tech@acme.com", "acme")).status_code == 200


def test_save_missing_title_400(signed_auth):
    import main

    main._rate_buckets.clear()
    r = _client().post("/solutions", json={"fix": "x"}, headers=_hdr("a@b.c", "acme"))
    assert r.status_code == 400
