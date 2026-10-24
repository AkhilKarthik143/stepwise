import { useState, type FormEvent } from "react";
import { apiUrl } from "../lib/api";

/**
 * Email + password sign-in gate (no sign-up). On success the backend returns the
 * API token that gates /offer + /ice-config; we store it as the app's existing
 * `apiToken` and hand control to the app. The server enforces auth regardless —
 * this is the UX layer.
 */
export function LoginGate({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    // Generous timeout: a free-tier backend can take ~50s to wake on the first
    // request, and we'd rather wait than fail a valid login.
    const ctrl = new AbortController();
    const to = window.setTimeout(() => ctrl.abort(), 90_000);
    try {
      const r = await fetch(apiUrl("/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
        signal: ctrl.signal,
      });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j && typeof j.token === "string" && j.token) {
          try {
            window.localStorage.setItem("apiToken", j.token);
          } catch {
            /* private mode — token stays in memory for this load only */
          }
          onAuthed();
          return;
        }
        setError("Signed in, but the server didn't return a token.");
      } else if (r.status === 401) {
        setError("Invalid email or password.");
      } else if (r.status === 429) {
        setError("Too many attempts — wait a minute and try again.");
      } else if (r.status === 503) {
        setError("Login isn't configured on this server.");
      } else {
        setError("Couldn't sign in. Please try again.");
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError("The server is taking a while — it may be waking up. Wait a moment and try again.");
      } else {
        setError("Network error — check your connection and try again.");
      }
    } finally {
      window.clearTimeout(to);
      setBusy(false);
    }
  };

  return (
    <div className="login-gate">
      <form className="login-card" onSubmit={submit} aria-label="Sign in">
        <h1 className="login-title">AR Technician Assistant</h1>
        <p className="login-sub">Sign in to continue</p>
        <label className="login-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            required
          />
        </label>
        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? (
          <div className="login-error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="login-btn" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
