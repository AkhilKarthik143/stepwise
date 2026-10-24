"""Login / auth tests: the pure credential check (config.verify_login +
_load_auth_users) and the HTTP surface (/login, /health auth_required).

The password is never stored in plaintext anywhere — tests derive a pbkdf2 hash
the same way the real loader expects (low iteration count for test speed)."""

from __future__ import annotations

import hashlib

import pytest

import config


def _hash(password: str, *, iters: int = 1000, salt: bytes = b"\x01" * 16) -> str:
    """Build a stored-hash string in config's pbkdf2_sha256 format."""
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iters)
    return f"pbkdf2_sha256${iters}${salt.hex()}${derived.hex()}"


@pytest.fixture
def auth_user(monkeypatch):
    """A configured single-user auth setup (token + one hashed user)."""
    users = {"tech@example.test": _hash("Sw0rdfish-Demo!")}
    monkeypatch.setattr(config, "AUTH_USERS", users)
    monkeypatch.setattr(config, "API_AUTH_TOKEN", "test-token-123")
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    return users


def _client():
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


def _reset_rate():
    import main

    main._rate_buckets.clear()


# ===========================================================================
# verify_login — the constant-time credential check
# ===========================================================================
def test_verify_login_accepts_correct_credentials(auth_user):
    assert config.verify_login("tech@example.test", "Sw0rdfish-Demo!") is True


def test_verify_login_email_is_case_insensitive(auth_user):
    assert config.verify_login("TECH@Example.TEST", "Sw0rdfish-Demo!") is True


def test_verify_login_trims_email_whitespace(auth_user):
    assert config.verify_login("  tech@example.test  ", "Sw0rdfish-Demo!") is True


def test_verify_login_rejects_wrong_password(auth_user):
    assert config.verify_login("tech@example.test", "sw0rdfish-demo!") is False  # case
    assert config.verify_login("tech@example.test", "wrong") is False


def test_verify_login_rejects_unknown_email(auth_user):
    assert config.verify_login("nobody@example.com", "Sw0rdfish-Demo!") is False


def test_verify_login_rejects_empty_password(auth_user):
    assert config.verify_login("tech@example.test", "") is False


def test_verify_login_rejects_non_string_inputs(auth_user):
    assert config.verify_login(None, "Sw0rdfish-Demo!") is False  # type: ignore[arg-type]
    assert config.verify_login("tech@example.test", None) is False  # type: ignore[arg-type]
    assert config.verify_login(123, 456) is False  # type: ignore[arg-type]


def test_verify_login_rejects_malformed_stored_hash(monkeypatch):
    monkeypatch.setattr(config, "AUTH_USERS", {"a@b.com": "not-a-real-hash"})
    assert config.verify_login("a@b.com", "whatever") is False


def test_verify_login_rejects_unknown_scheme(monkeypatch):
    monkeypatch.setattr(config, "AUTH_USERS", {"a@b.com": "bcrypt$1000$00$ab"})
    assert config.verify_login("a@b.com", "whatever") is False


# ===========================================================================
# _load_auth_users — env parsing
# ===========================================================================
def test_load_auth_users_parses_valid_json(monkeypatch):
    monkeypatch.setenv(
        "AUTH_USERS_JSON", '[{"email":"A@B.com","hash":"pbkdf2_sha256$1$00$ab"}]'
    )
    assert config._load_auth_users() == {"a@b.com": "pbkdf2_sha256$1$00$ab"}


def test_load_auth_users_empty_when_unset(monkeypatch):
    monkeypatch.delenv("AUTH_USERS_JSON", raising=False)
    assert config._load_auth_users() == {}


def test_load_auth_users_empty_on_bad_json(monkeypatch):
    monkeypatch.setenv("AUTH_USERS_JSON", "{not valid json")
    assert config._load_auth_users() == {}


def test_load_auth_users_skips_entries_missing_fields(monkeypatch):
    monkeypatch.setenv(
        "AUTH_USERS_JSON",
        '[{"email":"a@b.com"},{"hash":"x"},{"email":"c@d.com","hash":"h"}]',
    )
    assert config._load_auth_users() == {"c@d.com": "h"}


# ===========================================================================
# _dummy_pbkdf2_iters — anti-enumeration timing match
# ===========================================================================
def test_dummy_iters_matches_slowest_configured_user(monkeypatch):
    monkeypatch.setattr(
        config,
        "AUTH_USERS",
        {"a@b.com": _hash("x", iters=50_000), "c@d.com": _hash("y", iters=300_000)},
    )
    assert config._dummy_pbkdf2_iters() == 300_000


def test_dummy_iters_falls_back_when_no_parseable_hash(monkeypatch):
    monkeypatch.setattr(config, "AUTH_USERS", {})
    assert config._dummy_pbkdf2_iters() == 200_000
    monkeypatch.setattr(config, "AUTH_USERS", {"a@b.com": "garbage"})
    assert config._dummy_pbkdf2_iters() == 200_000


# ===========================================================================
# /health auth_required flag
# ===========================================================================
def test_health_reports_auth_required_true(auth_user):
    _reset_rate()
    r = _client().get("/health")
    assert r.status_code == 200
    assert r.json()["auth_required"] is True


def test_health_auth_required_false_when_disabled(monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    _reset_rate()
    r = _client().get("/health")
    assert r.json()["auth_required"] is False


# ===========================================================================
# /login endpoint
# ===========================================================================
def test_login_success_returns_token(auth_user):
    _reset_rate()
    r = _client().post(
        "/login", json={"email": "tech@example.test", "password": "Sw0rdfish-Demo!"}
    )
    assert r.status_code == 200
    token = r.json()["token"]
    # Multi-tenant: login returns a SIGNED per-user token (identity + company),
    # never the raw shared secret.
    from services import tenant_auth

    ident = tenant_auth.verify_token(token)
    assert ident is not None
    assert ident["email"] == "tech@example.test"
    assert ident["company"] == "default"
    assert token != "test-token-123"


def test_login_wrong_password_returns_401_no_token(auth_user):
    _reset_rate()
    r = _client().post(
        "/login", json={"email": "tech@example.test", "password": "nope"}
    )
    assert r.status_code == 401
    assert "token" not in r.json()


def test_login_unknown_email_returns_401(auth_user):
    _reset_rate()
    r = _client().post("/login", json={"email": "ghost@x.com", "password": "Sw0rdfish-Demo!"})
    assert r.status_code == 401


def test_login_503_when_not_configured(monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    _reset_rate()
    r = _client().post("/login", json={"email": "a@b.com", "password": "x"})
    assert r.status_code == 503


def test_login_rejects_non_object_body(auth_user):
    _reset_rate()
    r = _client().post("/login", json=5)  # valid JSON, not an object
    assert r.status_code == 401


def test_login_rejects_non_json_body(auth_user):
    _reset_rate()
    r = _client().post(
        "/login", content=b"\xff not json", headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 400


def test_login_error_body_never_leaks_token(auth_user):
    _reset_rate()
    r = _client().post("/login", json={"email": "x@y.com", "password": "bad"})
    assert "test-token-123" not in r.text
    assert "traceback" not in r.text.lower()


def test_login_rate_limited_returns_429(monkeypatch, auth_user):
    monkeypatch.setattr(config, "RATE_LIMIT_PER_MIN", 2)
    _reset_rate()
    c = _client()
    body = {"email": "x@y.com", "password": "bad"}
    assert c.post("/login", json=body).status_code == 401  # 1st: allowed
    assert c.post("/login", json=body).status_code == 401  # 2nd: allowed
    assert c.post("/login", json=body).status_code == 429  # 3rd: limited
