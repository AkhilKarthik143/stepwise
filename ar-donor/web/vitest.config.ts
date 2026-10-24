import { defineConfig } from "vitest/config";

// Unit tests for the PURE frontend logic (coverMap math, procedure reducer,
// jobHistory ring). Node environment — DOM-needing code stays out of these
// modules by design; tests stub the few globals (window.localStorage) inline.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
