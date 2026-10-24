import { describe, expect, it } from "vitest";
import { resolveAssetUrl } from "./assetUrl";

// Under vitest, import.meta.env.BASE_URL defaults to "/", so bare-relative paths
// resolve at the root. The pass-through rules are host-independent.
describe("resolveAssetUrl", () => {
  it("passes absolute and protocol-relative URLs through unchanged", () => {
    expect(resolveAssetUrl("https://cdn.example.com/pump.glb")).toBe(
      "https://cdn.example.com/pump.glb",
    );
    expect(resolveAssetUrl("http://x/y.glb")).toBe("http://x/y.glb");
    expect(resolveAssetUrl("//cdn.example.com/pump.glb")).toBe("//cdn.example.com/pump.glb");
  });

  it("passes data: and blob: URIs through unchanged", () => {
    expect(resolveAssetUrl("data:model/gltf-binary;base64,AAAA")).toBe(
      "data:model/gltf-binary;base64,AAAA",
    );
    expect(resolveAssetUrl("blob:abcd")).toBe("blob:abcd");
  });

  it("leaves an explicit root-absolute path as-is (no double-prefix)", () => {
    expect(resolveAssetUrl("/static/sample-assets/box.glb")).toBe(
      "/static/sample-assets/box.glb",
    );
    expect(resolveAssetUrl("/sample-assets/box.glb")).toBe("/sample-assets/box.glb");
  });

  it("resolves a bare relative path against the deploy base", () => {
    // BASE_URL is "/" in tests → root-rooted.
    expect(resolveAssetUrl("models/pump.glb")).toBe("/models/pump.glb");
    expect(resolveAssetUrl("sample-assets/box.glb")).toBe("/sample-assets/box.glb");
  });

  it("trims whitespace and tolerates empty input", () => {
    expect(resolveAssetUrl("  /static/x.glb  ")).toBe("/static/x.glb");
    expect(resolveAssetUrl("")).toBe("");
    expect(resolveAssetUrl("   ")).toBe("");
  });
});
