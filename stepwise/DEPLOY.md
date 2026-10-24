# Deploying BuildSight: backend on Railway, web app on Vercel

The backend (FastAPI, WebSocket, manual pictures, Claude and Cartesia calls) runs as one Docker container. The phone web app is static and runs on **Vercel**, pointed at the backend with `VITE_BACKEND_URL`. The backend also serves the same app at its own URL, a handy fallback if Vercel misbehaves.

Any host that runs a Dockerfile and keeps WebSockets open works. Railway is the default below. Render and Azure are at the end.

## 0. Before you deploy

Commit the builds you ingested. The container only knows the builds that are in git:

```bash
cd stepwise/backend
git add app/data/builds/<build_id>/build.json app/data/builds/<build_id>/steps
git commit -m "Add <build> manual" && git push
```

(`pages/` is gitignored. It's only needed for `--recrop` on your laptop.)

## 1. Backend on Railway

1. railway.com, sign in with GitHub, then **New Project**, then **Deploy from GitHub repo**, and pick the repo (the repo owner may need to grant Railway access).
2. Open the service's **Settings**:
   - **Root Directory:** `stepwise` (Railway then finds `Dockerfile` and `railway.json` there)
   - **Branch:** `stepwise`
3. **Variables** tab, add:
   ```
   ANTHROPIC_API_KEY=<your key>
   CARTESIA_API_KEY=<your key>
   CARTESIA_VOICE_ID=ef191366-f52f-447a-a398-ed8c0f2943a1
   CARTESIA_TTS_MODEL=sonic-3.6
   STEPWISE_ALLOWED_ORIGINS=https://<your-app>.vercel.app
   ```
4. **Settings, Networking, Generate Domain.** Railway gives you `https://<something>.up.railway.app`.
5. Check it: `https://<that-host>/api/config` should show `"claude_configured": true` and `"voice_out": "cartesia"`.

Every push to the `stepwise` branch redeploys automatically. Keep one replica (`railway.json` sets it): sessions and the dashboard live in memory.

## 2. Web app on Vercel

1. vercel.com, then **Add New**, then **Project**, then import the GitHub repo.
2. **Root Directory:** `stepwise/frontend`. Vercel reads `vercel.json` there (Vite, `npm run build`, output `dist`).
3. **Environment variable:** `VITE_BACKEND_URL` = `https://<railway host from step 1>` (no trailing slash).
4. **Deploy.** Vercel prints `https://<your-app>.vercel.app`.
5. Put that exact URL in `STEPWISE_ALLOWED_ORIGINS` on Railway if you haven't yet. For preview deployments too, also set `STEPWISE_ALLOWED_ORIGIN_REGEX=https://<your-app>-.*\.vercel\.app`.

`VITE_BACKEND_URL` is baked in at build time: after changing it, redeploy on Vercel.

## 3. At the demo table

- Phone: `https://<your-app>.vercel.app` (real certificate, camera works, no warnings)
- Dashboard laptop: `https://<your-app>.vercel.app/#dashboard`
- Fallback if Vercel is down: the Railway URL serves the same app

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red dot on the phone | Open `https://<backend host>/api/config` on the phone. If that fails, the backend is down (Railway, Deployments, View logs). If it works, `VITE_BACKEND_URL` is wrong: fix it and redeploy on Vercel |
| "Backend unreachable" with a CORS error in the browser console | `STEPWISE_ALLOWED_ORIGINS` must match the Vercel URL exactly, including `https://` |
| "No build loaded" | The build wasn't committed before deploying. Commit `build.json` + `steps/` and push |
| Checks say the Claude key is missing | The variable isn't set on the backend host, or the service didn't restart after you added it |

## Other backend hosts

**Render.** New, then Web Service, then pick the repo. Root Directory `stepwise`, Branch `stepwise`, Runtime Docker. Add the same variables. Health check path `/healthz`. The free plan sleeps after 15 minutes idle and takes about a minute to wake, so use the Starter plan for the demo.

**Azure Container Apps** (if the Microsoft track wants Azure). In Azure Cloud Shell (Bash):

```bash
git clone -b stepwise https://github.com/AkhilKarthik143/stepwise.git && cd stepwise/stepwise
az containerapp up --name buildsight --resource-group buildsight --location westus2 --source . --ingress external --target-port 8000
az containerapp secret set -n buildsight -g buildsight --secrets anthropic-key=<KEY> cartesia-key=<KEY>
az containerapp update -n buildsight -g buildsight --min-replicas 1 --max-replicas 1 \
  --set-env-vars ANTHROPIC_API_KEY=secretref:anthropic-key CARTESIA_API_KEY=secretref:cartesia-key \
    CARTESIA_VOICE_ID=ef191366-f52f-447a-a398-ed8c0f2943a1 CARTESIA_TTS_MODEL=sonic-3.6 \
    STEPWISE_ALLOWED_ORIGINS=https://<your-app>.vercel.app
```
