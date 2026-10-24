# Deploying BuildSight: backend on Azure, web app on Vercel

The backend (FastAPI, WebSocket, manual pictures, Claude and Cartesia calls) runs as one container on **Azure Container Apps**. The phone web app is static and runs on **Vercel**, pointed at the backend with `VITE_BACKEND_URL`. The backend also serves the same app at its own URL, which is a handy fallback if Vercel misbehaves.

## 0. Before you deploy

Commit the builds you ingested. The container only knows the builds that are in git:

```bash
cd stepwise/backend
git add app/data/builds/<build_id>/build.json app/data/builds/<build_id>/steps
git commit -m "Add <build> manual" && git push
```

(`pages/` is gitignored. It's only needed for `--recrop` on your laptop.)

## 1. Backend on Azure Container Apps

Use **Azure Cloud Shell** (the `>_` icon at the top of portal.azure.com, choose Bash). It already has `az` and `git`, so nothing to install on your Mac.

```bash
git clone -b stepwise https://github.com/AkhilKarthik143/stepwise.git
cd stepwise/stepwise
az containerapp up --name buildsight --resource-group buildsight --location westus2 \
  --source . --ingress external --target-port 8000
```

If the repo is private, clone with a GitHub token: `git clone -b stepwise https://<token>@github.com/AkhilKarthik143/stepwise.git`.

`az containerapp up` builds the `Dockerfile` in Azure, creates the registry, environment and app, and prints the app's URL. The first run takes several minutes.

Add the keys as secrets, keep exactly one replica (sessions and the dashboard live in memory), and allow the Vercel site:

```bash
az containerapp secret set -n buildsight -g buildsight \
  --secrets anthropic-key=<ANTHROPIC_API_KEY> cartesia-key=<CARTESIA_API_KEY>

az containerapp update -n buildsight -g buildsight --min-replicas 1 --max-replicas 1 \
  --set-env-vars ANTHROPIC_API_KEY=secretref:anthropic-key CARTESIA_API_KEY=secretref:cartesia-key \
    CARTESIA_VOICE_ID=ef191366-f52f-447a-a398-ed8c0f2943a1 CARTESIA_TTS_MODEL=sonic-3.6 \
    STEPWISE_ALLOWED_ORIGINS=https://<your-app>.vercel.app
```

Get the URL any time:

```bash
az containerapp show -n buildsight -g buildsight --query properties.configuration.ingress.fqdn -o tsv
```

Check it: `https://<that-host>/api/config` should show `"claude_configured": true` and `"voice_out": "cartesia"`.

**Redeploy after a code or build change:** in Cloud Shell, `cd stepwise && git pull && cd stepwise`, then run the same `az containerapp up` line. Secrets and settings are kept.

## 2. Web app on Vercel

1. vercel.com, then **Add New**, then **Project**, then import the GitHub repo (the repo owner may need to grant Vercel access).
2. **Root Directory:** `stepwise/frontend`. Vercel reads `vercel.json` there (Vite, `npm run build`, output `dist`).
3. **Environment variable:** `VITE_BACKEND_URL` = `https://<azure host from step 1>` (no trailing slash).
4. **Deploy.** Vercel prints `https://<your-app>.vercel.app`.
5. Put that exact URL in `STEPWISE_ALLOWED_ORIGINS` on Azure (step 1) if you haven't yet. For preview deployments too, also set `STEPWISE_ALLOWED_ORIGIN_REGEX=https://<your-app>-.*\.vercel\.app`.

`VITE_BACKEND_URL` is baked in at build time: after changing it, redeploy on Vercel.

## 3. At the demo table

- Phone: `https://<your-app>.vercel.app` (real certificate, camera works, no warnings)
- Dashboard laptop: `https://<your-app>.vercel.app/#dashboard`
- Fallback if Vercel is down: the Azure URL serves the same app

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red dot on the phone | Open `https://<azure host>/api/config` on the phone. If that fails, the backend is down (`az containerapp logs show -n buildsight -g buildsight --follow`). If it works, `VITE_BACKEND_URL` is wrong: fix it and redeploy on Vercel |
| "Backend unreachable" with a CORS error in the browser console | `STEPWISE_ALLOWED_ORIGINS` must match the Vercel URL exactly, including `https://` |
| "No build loaded" | The build wasn't committed before deploying. Commit `build.json` + `steps/`, then redeploy |
| Checks say the Claude key is missing | The secret or env var isn't set. Re-run the `secret set` and `update` commands |
