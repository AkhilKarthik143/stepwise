import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessToken, passcode, safeEqual } from "@/lib/access";

// Checks the passcode and sets the access cookie.
export async function POST(request: Request) {
  const code = passcode();
  if (!code) return Response.json({ ok: true });

  let given = "";
  try {
    given = String((await request.json())?.passcode ?? "").trim();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  // Small fixed delay makes guessing slower.
  await new Promise((r) => setTimeout(r, 400));
  if (!safeEqual(given.toLowerCase(), code.toLowerCase())) {
    return Response.json({ error: "That passcode isn't right." }, { status: 401 });
  }

  const token = await accessToken(code);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${ACCESS_COOKIE}=${token}; Path=/; Max-Age=${ACCESS_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
