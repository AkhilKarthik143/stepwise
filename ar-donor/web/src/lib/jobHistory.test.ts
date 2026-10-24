import { beforeEach, describe, expect, it } from "vitest";

/** In-memory localStorage stub, with an optional byte budget for quota tests. */
class MemoryStorage {
  private m = new Map<string, string>();
  constructor(public byteLimit = Infinity) {}
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    if (v.length > this.byteLimit) throw new DOMException("quota", "QuotaExceededError");
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

let storage: MemoryStorage;
(globalThis as any).window = {};

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as any).window.localStorage = storage;
});

// Import AFTER the window stub exists at module scope (functions read it lazily).
import { clearJobs, listJobs, saveJob } from "./jobHistory";

const job = (startedAt: number, turns = 1) => ({
  startedAt,
  endedAt: startedAt + 60_000,
  transcript: Array.from({ length: turns }, (_, i) => ({
    id: i,
    text: `turn ${i}`,
    at: startedAt + i,
    role: "assistant" as const,
  })),
  marks: [],
});

describe("jobHistory ring", () => {
  it("saves newest-first and dedupes by startedAt", () => {
    saveJob(job(100));
    saveJob(job(200));
    saveJob({ ...job(100), endedAt: 999_999 }); // re-save same session
    const jobs = listJobs();
    expect(jobs.map((j) => j.startedAt)).toEqual([100, 200]);
    expect(jobs[0].endedAt).toBe(999_999); // replaced, not duplicated
  });

  it("caps the ring at 12 (oldest evicted)", () => {
    for (let i = 1; i <= 15; i++) saveJob(job(i * 1000));
    const jobs = listJobs();
    expect(jobs).toHaveLength(12);
    expect(jobs[0].startedAt).toBe(15_000); // newest first
    expect(jobs[jobs.length - 1]?.startedAt).toBe(4_000); // 1..3k evicted
  });

  it("under quota pressure, shrinks the ring but ALWAYS keeps the newest record", () => {
    for (let i = 1; i <= 12; i++) saveJob(job(i * 1000, 5));
    // Now impose a budget that can only fit ~a few records.
    const fits3 = JSON.stringify(listJobs().slice(0, 3)).length + 50;
    storage.byteLimit = fits3;
    saveJob(job(99_000, 5)); // must survive via shrink-and-retry
    const jobs = listJobs();
    expect(jobs[0].startedAt).toBe(99_000); // the just-finished job survived
    expect(jobs.length).toBeLessThanOrEqual(3);
  });

  it("filters corrupt elements instead of crashing the render path", () => {
    saveJob(job(100));
    const raw = JSON.parse(storage.getItem("jobHistory.v1") as string);
    raw[0].transcript.push(null, { text: 42 }, { text: "ok", role: "assistant", at: 5 });
    raw[0].marks.push(null, "junk", { label: "valid mark" });
    raw.push("not-a-job", { startedAt: "nope" });
    storage.setItem("jobHistory.v1", JSON.stringify(raw));
    const jobs = listJobs();
    expect(jobs).toHaveLength(1); // junk top-level entries dropped
    expect(jobs[0].transcript.every((t: any) => typeof t.text === "string")).toBe(true);
    expect(jobs[0].marks).toEqual([{ label: "valid mark" }]);
  });

  it("clearJobs empties the ring; storage failures never throw", () => {
    saveJob(job(100));
    clearJobs();
    expect(listJobs()).toEqual([]);
    storage.byteLimit = 0; // every write fails
    expect(() => saveJob(job(200))).not.toThrow();
  });

  it("round-trips a persisted diagram (model) through save -> load", () => {
    saveJob({
      ...job(100),
      model: {
        mode: "2d",
        title: "Relay wiring",
        caption: "",
        parts: [
          { shape: "rect", position: [50, 50], size: [20, 10], rotation: [0], color: "info", label: "K1" },
        ],
        emphasis: [],
        activeStep: 0,
      },
    });
    const jobs = listJobs();
    expect(jobs[0].model?.title).toBe("Relay wiring");
    expect(jobs[0].model?.mode).toBe("2d");
    expect(jobs[0].model?.parts[0].shape).toBe("rect");
    expect(jobs[0].model?.parts[0].label).toBe("K1");
  });

  it("degrades a CORRUPT persisted model to null without dropping the job", () => {
    saveJob(job(100));
    const raw = JSON.parse(storage.getItem("jobHistory.v1") as string);
    raw[0].model = { parts: "notarray" }; // malformed -> normalizeModelSpec returns null
    storage.setItem("jobHistory.v1", JSON.stringify(raw));
    const jobs = listJobs();
    expect(jobs).toHaveLength(1); // job survives
    expect(jobs[0].model).toBeNull(); // garbage diagram dropped
  });

  it("coerces a tampered string `sources` to undefined (no render-path crash)", () => {
    saveJob(job(100));
    const raw = JSON.parse(storage.getItem("jobHistory.v1") as string);
    raw[0].transcript[0].sources = "boom"; // tampered non-array would crash .join
    storage.setItem("jobHistory.v1", JSON.stringify(raw));
    const jobs = listJobs();
    expect(jobs).toHaveLength(1); // job survives
    expect(jobs[0].transcript[0].sources).toBeUndefined(); // coerced, not a string
  });

  it("keeps a valid string[] `sources` and cleans an array of non-strings", () => {
    saveJob(job(100));
    const raw = JSON.parse(storage.getItem("jobHistory.v1") as string);
    raw[0].transcript[0].sources = ["Manual A", 5, "Manual B"];
    storage.setItem("jobHistory.v1", JSON.stringify(raw));
    const jobs = listJobs();
    expect(jobs[0].transcript[0].sources).toEqual(["Manual A", "Manual B"]);
  });

  it("loads an OLD job with no model key as model:null (back-compat)", () => {
    saveJob(job(100)); // job() has no model field
    const jobs = listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].model).toBeNull();
  });

  it("drops an all-invalid model to null but keeps a partially-valid one", () => {
    saveJob({
      ...job(100),
      model: {
        mode: "3d",
        title: "Mixed",
        caption: "x",
        parts: [
          { shape: "bogus" }, // dropped
          { shape: "box", position: [0, 0, 0], size: [1, 1, 1], rotation: [0], color: "metal", label: "ok" },
        ],
      },
    } as any);
    const jobs = listJobs();
    expect(jobs[0].model?.parts).toHaveLength(1); // only the valid box survives
    expect(jobs[0].model?.parts[0].color).toBe("metal");
  });
});
