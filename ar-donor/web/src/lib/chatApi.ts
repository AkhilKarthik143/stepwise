import { apiUrl } from "./api";
import { authToken } from "./useWebRTC";

/** One message in the chat transcript. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  /** data URL of an image the user attached (shown as a thumbnail). */
  image?: string;
  /** data URL of an image the assistant generated. */
  genImage?: string;
  /** true if this assistant turn is an error notice. */
  error?: boolean;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const t = authToken();
  if (t) h["X-API-Key"] = t;
  return h;
}

async function errorText(r: Response): Promise<string> {
  const j = await r.json().catch(() => ({}));
  return (j && j.error) || `Request failed (${r.status})`;
}

/** Trim the transcript to a plain {role,text} history for the backend
 *  (drops images + empty turns, keeps the last `max`). Pure + testable. */
export function toHistory(
  turns: ChatTurn[],
  max = 16,
): { role: string; text: string }[] {
  return turns
    .filter((t) => t.text && t.text.trim() && !t.error)
    .slice(-max)
    .map((t) => ({ role: t.role, text: t.text }));
}

/** Send a chat turn (text + optional image) and return the assistant's reply. */
export async function sendChat(
  text: string,
  image: string | undefined,
  history: { role: string; text: string }[],
): Promise<string> {
  const r = await fetch(apiUrl("/chat"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ text, image, history }),
  });
  if (!r.ok) throw new Error(await errorText(r));
  return (await r.json()).reply as string;
}

/** Run the NVIDIA recognizer on an image; returns the detection text. */
export async function recognizeImage(image: string, prompt?: string): Promise<string> {
  const r = await fetch(apiUrl("/recognize"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ image, prompt }),
  });
  if (!r.ok) throw new Error(await errorText(r));
  return (await r.json()).detections as string;
}

/** Generate an image from a prompt; returns a ready-to-use data URL. */
export async function generateImage(prompt: string): Promise<string> {
  const r = await fetch(apiUrl("/generate-image"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt }),
  });
  if (!r.ok) throw new Error(await errorText(r));
  const j = await r.json();
  return `data:${j.mime || "image/png"};base64,${j.image}`;
}

/** Read a File (image) into a data URL for preview + upload. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Could not read the file."));
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(file);
  });
}
