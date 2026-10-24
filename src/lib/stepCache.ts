// Steps Claude read from a catalog manual's page, kept on the server so every device gets them
// instantly after the first read (each browser also keeps its own copy in IndexedDB).
// Keyed by "<pdf link>#<page>". Lives until the container restarts. Server-only.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = path.join(tmpdir(), "buildsight-steps");
const memory = new Map<string, unknown>();

const fileFor = (key: string) => path.join(DIR, `${createHash("sha1").update(key).digest("hex")}.json`);

export async function readSteps<T>(key: string): Promise<T | null> {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const value = JSON.parse(await readFile(fileFor(key), "utf8")) as T;
    memory.set(key, value);
    return value;
  } catch {
    return null;
  }
}

export async function saveSteps(key: string, steps: unknown) {
  memory.set(key, steps);
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(fileFor(key), JSON.stringify(steps));
  } catch {
    // disk full or read-only: the in-memory copy still works
  }
}
