import { describe, expect, it } from "vitest";
import { apiUrl } from "./api";

// VITE_API_BASE is unset under vitest, so BASE === "" (same-origin) — the local
// dev / all-in-one path. We assert the path-normalizing contract that holds for
// every base: exactly one leading slash, no double slashes, query preserved.
describe("apiUrl (same-origin default)", () => {
  it("returns a root-relative path for a leading-slash input", () => {
    expect(apiUrl("/login")).toBe("/login");
    expect(apiUrl("/offer")).toBe("/offer");
    expect(apiUrl("/notebooks/switch")).toBe("/notebooks/switch");
  });

  it("prepends a slash when the caller omits it", () => {
    expect(apiUrl("health")).toBe("/health");
  });

  it("preserves query strings", () => {
    expect(apiUrl("/ice-config?token=abc")).toBe("/ice-config?token=abc");
  });

  it("never produces a double leading slash", () => {
    for (const p of ["/login", "login", "/a/b", "a/b"]) {
      expect(apiUrl(p).startsWith("//")).toBe(false);
      expect(apiUrl(p).startsWith("/")).toBe(true);
    }
  });
});
