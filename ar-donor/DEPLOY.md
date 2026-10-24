# Deploying the AR Technician Assistant to the web

This puts the app online behind a login, reachable from any phone/iPad/laptop.

## Architecture

```
   Browser (HTTPS)
      │
      ├──────────────►  Vercel        — the React app (static files)
      │                                 build: APP_BASE=/ npm run build  (root dir: web/)
      │
      └──────────────►  Render        — the FastAPI backend (Docker)
                          │             /login /offer /ice-config /health /notebooks
                          │             WebRTC media + Gemini Live + (optional) NotebookLM
                          ▼
                        TURN relay     — managed (Metered / Twilio / Cloudflare)
                                         needed for media across cellular / locked-down NATs
```

Two hosts because Vercel is serverless (no place for the persistent WebRTC/WebSocket
backend). The frontend talks to the backend cross-origin via `VITE_API_BASE`; CORS on
the backend (`ALLOWED_ORIGINS`) allows the Vercel domain.

Both Vercel and Render serve HTTPS automatically — required for camera/mic access.

---

## Prerequisites (accounts — all have free tiers)

1. **GitHub** — holds the code. Render + Vercel deploy from it.
2. **Render** — the backend. Sign in with GitHub.
3. **Vercel** — the frontend. Sign in with GitHub.
4. **A managed TURN provider** — e.g. [Metered](https://www.metered.ca/tools/openrelay/)
   (has a free tier) or Twilio. Gives you `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL`.

You never paste account passwords anywhere. Vercel and Render connect to GitHub via
their "Sign in with GitHub" button (OAuth). The only secret you hand over is a GitHub
**fine-grained Personal Access Token scoped to one repo** (see Step 1), used only to push.

---

## Step 1 — Code onto GitHub

1. Create a new **empty** repo at <https://github.com/new> (e.g. `ar-technician-assistant`).
   Do not add a README/.gitignore (the repo already has them).
2. Create a **fine-grained token**: GitHub → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → *Generate new token*.
   - **Repository access**: Only select repositories → the repo you just made.
   - **Permissions**: Repository permissions → **Contents: Read and write**. Nothing else.
   - Generate, copy the token (starts `github_pat_…`).
3. Give me the **repo URL** and the **token** and I push for you. (Or push yourself:)
   ```bash
   cd ar-technician-assistant
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main         # paste the token as the password when asked
   ```

The token is repo-scoped and revocable (delete it after the first push if you like;
future pushes can use a fresh one or the GitHub CLI).

---

## Step 2 — Backend on Render

1. <https://dashboard.render.com> → **New** → **Blueprint** → connect the GitHub repo.
   Render reads [`render.yaml`](render.yaml) and creates a Docker web service.
   (Or **New → Web Service**, pick the repo, Runtime = **Docker** — it finds the `Dockerfile`.)
2. Set the environment variables (Render dashboard → the service → Environment):

   | Variable | Value |
   |---|---|
   | `GEMINI_API_KEY` | your Gemini API key |
   | `ACTIVE_NOTEBOOK_ID` | `8f03eac0-8214-40f1-adae-30d37c7de989` (or leave unset — see caveat) |
   | `API_AUTH_TOKEN` | the token from your local `.env` (long random string) |
   | `AUTH_USERS_JSON` | the **exact** value from your local `.env` (both hashed users) |
   | `ALLOWED_ORIGINS` | set in Step 4 once you know the Vercel URL |
   | `TURN_URL` | one URL, or a **comma-separated list** of transports (recommended) so the browser can fall back to TLS:443 on cellular. OpenRelay example: `turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443,turns:openrelay.metered.ca:443?transport=tcp` |
   | `TURN_USERNAME` | from your TURN provider |
   | `TURN_CREDENTIAL` | from your TURN provider |
   | `TRUST_FORWARDED_FOR` | `true` (already in `render.yaml`) |

   > Copy `API_AUTH_TOKEN` and `AUTH_USERS_JSON` verbatim from the local `.env` so the
   > same two logins work online. They are NOT in the repo (`.env` is gitignored).

3. Deploy. When it's live, copy the URL: `https://<name>.onrender.com`.
   Open `https://<name>.onrender.com/health` — it should return JSON with
   `"auth_required": true`.

**Free tier note:** the service sleeps after ~15 min idle and cold-starts slowly. Fine
for a demo; for real use switch the plan to **Starter** (always-on).

---

## Step 3 — Frontend on Vercel

1. <https://vercel.com/new> → import the GitHub repo.
2. **Root Directory**: `web`  (important — the app lives in `web/`).
   Framework preset = **Vite** (auto-detected). The build command is pinned in
   [`web/vercel.json`](web/vercel.json) to `APP_BASE=/ npm run build` so assets resolve
   at the domain root.
3. **Environment Variable**:

   | Variable | Value |
   |---|---|
   | `VITE_API_BASE` | the Render URL from Step 2, e.g. `https://<name>.onrender.com` |

4. Deploy. Copy the Vercel URL, e.g. `https://ar-technician.vercel.app`.

---

## Step 4 — Let the browser talk to the backend (CORS)

On **Render**, set `ALLOWED_ORIGINS` to your exact Vercel origin (no trailing slash):

```
ALLOWED_ORIGINS=https://ar-technician.vercel.app
```

Save → Render redeploys. (Multiple origins: comma-separate them. Do **not** leave it `*`
in production.)

---

## Step 5 — Verify

Open the Vercel URL on your phone:

1. You see the **login screen**.
2. Wrong password → "Invalid email or password."
3. Correct login (`omer200338@gmail.com` or `omethetrader@gmail.com`) → the app loads.
4. **Connect to AI Assistant** → grant camera + mic → the assistant sees your camera and
   talks back, and can draw 2D/3D diagrams.
5. **Sign out** (top bar) → back to the login screen.

If media connects on Wi-Fi but not on cellular, your TURN creds (Step 2) are wrong or
missing — that relay is what makes it work across carrier NATs.

**Quick backend check (any time):** run the smoke test against your Render URL to confirm
the API + cross-origin contract are healthy (no deps, stdlib Python):

```bash
# basic checks:
python scripts/smoke_deploy.py https://<your-backend-url>
# add your Vercel origin + a real login to ALSO verify TURN is served:
python scripts/smoke_deploy.py https://<your-backend-url> https://<your>.vercel.app <email> <password>
```

It checks `/health`, `/login` (wrong creds → 401), `/ice-config` (no-auth → 401), and the
CORS preflight for `/login` and `/offer`. With creds it also logs in and confirms
`/ice-config` serves a **TURN relay** (not just STUN) — the check that would have caught
the dead-relay outage. Exits 0 when all pass. (First run may take ~50s on a cold host.)

---

## Caveats / known limits

- **NotebookLM grounding** uses browser-cookie auth, which does not exist on a headless
  server — so manual-grounded citations are effectively **off in the cloud** unless you
  re-auth notebooklm there. The assistant still works (live vision + voice + diagrams);
  it just won't cite the manual. Leaving `ACTIVE_NOTEBOOK_ID` unset is fine — the code
  degrades gracefully (`notebook_configured: false`).
- **Docker build:** the image first builds on Render (Docker isn't required locally). If
  a native dependency ever fails to find a wheel, the fix is to add a build toolchain to
  the `Dockerfile` (`build-essential`, and `rust`/`cargo` if it's `rookiepy`). Not
  expected on Python 3.11.
- **3D model assets (`MODEL_ASSETS_JSON`):** the primitive 2D/3D diagrams work
  everywhere (no network). For real `.glb`/`.gltf` models, use either an absolute
  CDN URL (`https://…`, portable to any host) or a **bare relative** path
  (`models/pump.glb`) — the app resolves bare-relative URLs against its deploy
  base, so the same catalog entry works on both Vercel (`/`) and the all-in-one
  host (`/static/`). A root-absolute `/static/…` URL is the all-in-one host only.
- **Secrets:** `.env` is gitignored and excluded from the Docker image
  (`.dockerignore`). All secrets live only in the Render/Vercel dashboards.
- **Adding/removing users:** edit `AUTH_USERS_JSON` on Render (same JSON shape). Hash new
  passwords with the project's pbkdf2 format — ask and I'll generate the hash.

---

## Multi-tenant: companies + Solution Memory

Each user belongs to a **company** (tenant). Add a `"company"` field to their
`AUTH_USERS_JSON` entry (omit = the `default` company):

```json
[{"email":"tech@acme.com","hash":"pbkdf2_sha256$...","company":"acme"},
 {"email":"eng@globex.com","hash":"pbkdf2_sha256$...","company":"globex"}]
```

How tenancy works:

- **Login returns a signed per-user token** (HMAC-signed with `API_AUTH_TOKEN`; 30-day
  expiry) carrying the user's email + company. Every API call is scoped server-side to
  the company in the verified token — a client can never address another tenant's data.
- **Each company gets its own database + photo directory** under
  `DATA_DIR/tenants/<company>/` (`solutions.db` + `photos/`). Physical isolation: easy
  per-company backup/export/delete.
- **Solution Memory**: `POST /solutions` saves a solved case (title, equipment, problem,
  fix, tags, optional photo); `GET /solutions?q=` searches the company's past cases;
  `GET /solutions/{id}` returns one case with its photo. In the app: the
  **📚 Past solutions** button on the start screen.
- **Persistence**: `deploy/docker-compose.yml` mounts a named volume at `/app/data`, so
  tenant data survives rebuilds. Back it up with
  `sudo docker run --rm -v deploy_app_data:/d -v $(pwd):/out alpine tar czf /out/tenants-backup.tgz /d`.
- **Rotating `API_AUTH_TOKEN` logs everyone out** (it signs the tokens) — users just log
  in again.

**Confidential-data note:** chat/recognizer content is still processed by Gemini/NVIDIA
cloud APIs under standard terms. For companies with truly secret data, the plan is to
switch those calls to enterprise endpoints (Vertex AI etc.) with no-training/DPA terms —
tracked as the next phase.

---

## Troubleshooting (issues we actually hit)

- **Vercel auto-detects "FastAPI" / Root Directory `./`.** Wrong for the frontend. The
  React app lives in `web/`, so set **Root Directory = `web`** and **Framework/Preset =
  `Vite`**. Deploying with the FastAPI preset tries to run the Python backend on Vercel's
  serverless runtime (no persistent WebRTC/WebSocket) and fails — that's what Render is for.
- **GitHub push fails `403 / Permission denied` with a fine-grained token.** The token is
  accepted (you're authenticated) but lacks write. Fine-grained tokens default every
  permission to "no access" — you must set **Repository permissions → Contents → Read and
  write** AND select the repo under **Repository access**. The summary page shows Contents
  as "code"; if it's in the *read* list, push is denied. (A classic token with the single
  `repo` scope avoids the per-permission dropdowns entirely.)
- **`404 Not Found` right after a Render deploy / env-var change.** The free instance is
  rolling out or cold-starting; requests flap between 200 and 404 for a minute, then settle.
  Confirm with `scripts/smoke_deploy.py <url>` once it's done.
- **NotebookLM error in the Render logs** (`Storage file not found … Run 'notebooklm
  login'`). Expected on a headless server — cookie auth doesn't exist there. It's caught;
  the app runs without manual citations. Leave `ACTIVE_NOTEBOOK_ID` unset to silence it.
- **Login works but the live video won't connect (`PC state: failed`).** ICE couldn't
  find a media path — almost always TURN. Set `TURN_URL` / `TURN_USERNAME` /
  `TURN_CREDENTIAL` on Render. Crucially, give `TURN_URL` **multiple transports**
  (comma-separated, incl. a `turns:…:443?transport=tcp` entry) so the browser can fall
  back to TLS:443 when the network blocks plain UDP — a single UDP-only TURN URL fails on
  many cellular/locked-down networks. Verify with `GET /ice-config` (authed): the TURN
  entry's `urls` should be the full list. Public relays can be rate-limited — for reliable
  use, get free dedicated creds at metered.ca. **Before deploying any TURN creds, test that
  they actually relay:** `python scripts/turn_test.py "<urls>" <username> <credential>` —
  it gathers ICE with aiortc and prints `relay(TURN)=N`; `N > 0` = the creds work, `N == 0`
  = they're dead (the free public OpenRelay creds currently return 0 — don't use them).
- **Browser shows a CORS error calling the backend.** `ALLOWED_ORIGINS` on Render must be
  the exact Vercel origin (scheme + host, no trailing slash), e.g.
  `https://ar-technician-assistant.vercel.app`. Multiple origins: comma-separate.
- **First load is slow (~50s) then fine.** Free-tier cold start after 15 min idle. The UI
  shows "Waking up the server…". Switch the Render plan to Starter for always-on.

---

## Alternative backend host: AWS App Runner

App Runner runs the backend **from source** on a managed Python runtime — no Docker, no
ECR — thanks to [`apprunner.yaml`](apprunner.yaml) + `opencv-python-headless`. It works
because the backend only serves HTTP; all real-time media is WebRTC over the TURN relay
and the Gemini link is an outbound WebSocket.

1. <https://console.aws.amazon.com/apprunner> → **Create service**.
2. **Source**: "Source code repository" → connect GitHub → pick the repo, branch `main`.
3. **Deployment trigger**: Automatic (redeploy on push).
4. **Build settings**: choose **"Use a configuration file"** (it reads `apprunner.yaml`).
5. **Service settings**:
   - **Region**: **Frankfurt (eu-central-1)** — low latency to Israel (vs Oregon).
   - **vCPU / Memory**: **1 vCPU / 2 GB** (do NOT pick the smallest — under-powered CPU
     was the slowness on Render Free).
   - **Port**: `8080` (matches `apprunner.yaml`).
   - **Health check**: protocol HTTP, path `/health`.
   - **Environment variables**: add `GEMINI_API_KEY`, `API_AUTH_TOKEN`, `AUTH_USERS_JSON`,
     `ALLOWED_ORIGINS` (your Vercel origin), `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
     (`TRUST_FORWARDED_FOR=true` is already set by `apprunner.yaml`.)
6. **Create & deploy.** When it shows **Running**, copy the URL
   (`https://xxxx.eu-central-1.awsapprunner.com`).
7. In **Vercel** set `VITE_API_BASE` to that URL and redeploy; set `ALLOWED_ORIGINS` on
   App Runner to your Vercel origin. Verify: `python scripts/smoke_deploy.py <app-runner-url>`.

**Cost:** App Runner bills for the provisioned instance (~$25–40/mo for 1 vCPU always-on);
12-month AWS free tier + credits apply. If the source build ever fails on a native wheel,
the fallback is the container path (push the `Dockerfile` image to ECR and point App Runner
at it).

---

## Enabling NotebookLM grounding in the cloud (optional)

NotebookLM logs in with browser cookies, which don't exist on a server — that's why it's
off in the cloud by default. To turn it on, inject your already-logged-in cookies:

1. **Find your local cookie file** (created by `notebooklm login` on the machine where it
   worked): `~/.notebooklm/profiles/default/storage_state.json` (Windows:
   `C:\Users\<you>\.notebooklm\profiles\default\storage_state.json`). If `NOTEBOOKLM_HOME`
   is set, it's under there instead.
2. Open it and copy the **entire JSON content**.
3. On the host, set two env vars:
   - `NOTEBOOKLM_STORAGE_STATE_JSON` = that whole JSON (the app writes it to disk at startup)
   - `ACTIVE_NOTEBOOK_ID` = your notebook id (e.g. `8f03eac0-8214-40f1-adae-30d37c7de989`)
4. Redeploy. The startup log should no longer show the "Storage file not found" error.

**Caveats (important):** these cookies **expire** (days–weeks) — when grounding stops, re-export
and update the env var. This uses an **unofficial** automation path (no official NotebookLM
API), so it's fragile and could break or risk the Google account. Treat the JSON as a
**secret** — it grants NotebookLM access as that account. For a robust product, an official
RAG (e.g. Vertex AI Search or your own vector DB over the manuals) is the long-term path.

---

## Strong, always-on backend on AWS Lightsail (VM + auto-HTTPS)

For real multi-user use you want **always-on CPU** (App Runner throttles CPU between HTTP
requests, which starves the background media loop). A Lightsail VM gives a real CPU that
never throttles, for a fixed price, and uses AWS credits. The [`deploy/`](deploy/) bundle
runs the app behind **Caddy**, which fetches HTTPS automatically — so no certificate or
load-balancer wrangling.

1. **Free HTTPS domain:** sign up at <https://www.duckdns.org> (login with Google/GitHub),
   create a subdomain (e.g. `aragent.duckdns.org`). You'll point it at the VM's IP in step 3.
2. **Create the VM:** Lightsail → **Create instance** → Region **Frankfurt** → **Linux/Ubuntu
   22.04** → plan **$20/mo (2 vCPU / 4 GB)** (handles ~5 users; $24/6mo of credits ≈ $120).
   Create. Then **Networking** → open ports **80** and **443** (HTTP/HTTPS) in the firewall.
3. Point your DuckDNS subdomain's IP at the instance's **public IP** (Lightsail shows it).
4. **Connect** → click **"Connect using SSH"** (opens a browser terminal — no keys needed).
5. Paste:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/omer-izhaki/-ar-technician-assistant/main/deploy/lightsail-setup.sh | bash
   ```
   It installs Docker, clones the repo, and creates `deploy/.env`, then stops.
6. Edit the env file: `nano ~/ar-technician-assistant/deploy/.env` — set `APP_DOMAIN` to your
   DuckDNS name and fill the secrets (copy `GEMINI_API_KEY` / `API_AUTH_TOKEN` /
   `AUTH_USERS_JSON` from Render; the TURN values from Metered). Save (Ctrl-O, Enter, Ctrl-X).
7. Run it again to build + start:
   ```bash
   bash ~/ar-technician-assistant/deploy/lightsail-setup.sh
   ```
   Caddy gets HTTPS within ~1 min. Verify: `curl -s https://<your-domain>/health`.
8. Point **Vercel**'s `VITE_API_BASE` at `https://<your-domain>` and redeploy. Smoke-test:
   `python scripts/smoke_deploy.py https://<your-domain> https://<vercel-origin> <email> <password>`.

**Cost:** the $20/mo Lightsail instance ≈ $120 of your $200 credits over 6 months. (Gemini
Live API is billed **separately** on your Google key — watch that one; it's the real
variable cost for 5 daily users.)
