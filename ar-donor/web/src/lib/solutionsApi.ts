import { apiUrl } from "./api";
import { authToken } from "./useWebRTC";

/** A solved case in the company's Solution Memory. */
export interface Solution {
  id: string;
  ts: number;
  author: string;
  title: string;
  equipment: string;
  problem: string;
  fix: string;
  tags: string;
  hasPhoto: boolean;
  /** Present only on detail fetches. */
  photo?: string;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const t = authToken();
  if (t) h["X-API-Key"] = t;
  return h;
}

async function fail(r: Response): Promise<never> {
  const j = await r.json().catch(() => ({}));
  throw new Error((j && j.error) || `Request failed (${r.status})`);
}

export async function searchSolutions(q: string): Promise<Solution[]> {
  const r = await fetch(apiUrl(`/solutions?q=${encodeURIComponent(q)}`), { headers: headers() });
  if (!r.ok) await fail(r);
  return (await r.json()).solutions as Solution[];
}

export async function getSolution(id: string): Promise<Solution> {
  const r = await fetch(apiUrl(`/solutions/${encodeURIComponent(id)}`), { headers: headers() });
  if (!r.ok) await fail(r);
  return (await r.json()).solution as Solution;
}

export async function saveSolution(input: {
  title: string;
  equipment?: string;
  problem?: string;
  fix?: string;
  tags?: string;
  photo?: string;
}): Promise<string> {
  const r = await fetch(apiUrl("/solutions"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
  if (!r.ok) await fail(r);
  return (await r.json()).id as string;
}
