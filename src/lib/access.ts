// Passcode lock. When APP_PASSCODE is set, every page and API call needs the access cookie,
// so nobody with just the link can spend the API key. Unset = no lock (handy for local dev).

export const ACCESS_COOKIE = "bs_access";
export const ACCESS_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function passcode(): string | null {
  return process.env.APP_PASSCODE?.trim() || null;
}

// The cookie holds a hash of the passcode, never the passcode itself.
export async function accessToken(code: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`buildsight:${code}`));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare, so response timing doesn't leak how much matched.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
