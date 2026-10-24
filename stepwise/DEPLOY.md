# Deploying BuildSight on Azure

One container on **Azure Container Apps** runs everything: the phone web app, the API, the WebSocket (voice and live checks), and the Claude and Cartesia calls. One https URL, a real certificate, no Vercel needed. **Application Insights** records latency per turn, checks and mistakes. A **passcode** keeps strangers with the link from spending the API keys.

## 0. Before you deploy

Commit the builds you ingested. The container only knows the builds that are in git:

```bash
cd stepwise/backend
git add app/data/builds/<build_id>/build.json app/data/builds/<build_id>/steps
git commit -m "Add <build> manual" && git push
```

## 1. Create the app (Azure Cloud Shell, once)

The image is built by GitHub Actions (`.github/workflows/image.yml`) on every push to `stepwise` and published to `ghcr.io/<owner>/buildsight`. Azure only pulls it: its own builder (ACR Tasks) is blocked on new and student subscriptions.

We deploy from the fork `citricice/stepwise`, so the image is `ghcr.io/citricice/buildsight`. Once: make that package public (GitHub, Packages, buildsight, Package settings, Change visibility, Public). The image holds code and manuals, never keys.

Open portal.azure.com, click the `>_` icon at the top, choose **Bash**:

```bash
az extension add --name containerapp --upgrade
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Insights; do az provider register --namespace $ns; done
az containerapp up --name buildsight --resource-group buildsight --location westus2 \
  --image ghcr.io/citricice/buildsight:latest --ingress external --target-port 8000
```

New subscriptions take a minute or two to register those services; if `up` says a namespace isn't registered, wait and run it again. It prints the app URL when done.

## 2. Application Insights (once)

```bash
az monitor app-insights component create --app buildsight-insights -g buildsight --location westus2
az monitor app-insights component show --app buildsight-insights -g buildsight --query connectionString -o tsv
```

Copy the connection string it prints (starts with `InstrumentationKey=`). If `az` asks to install the `application-insights` extension, say yes.

## 3. Keys, passcode, settings

Type the real values here, in Cloud Shell only:

```bash
az containerapp secret set -n buildsight -g buildsight --secrets \
  anthropic-key=<ANTHROPIC_API_KEY> cartesia-key=<CARTESIA_API_KEY> \
  app-passcode=<a passcode for your team> insights=<connection string from step 2>

az containerapp update -n buildsight -g buildsight --min-replicas 1 --max-replicas 1 \
  --set-env-vars ANTHROPIC_API_KEY=secretref:anthropic-key CARTESIA_API_KEY=secretref:cartesia-key \
    APP_PASSCODE=secretref:app-passcode APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:insights \
    CARTESIA_VOICE_ID=ef191366-f52f-447a-a398-ed8c0f2943a1 CARTESIA_TTS_MODEL=sonic-3.6
```

`--min-replicas 1` keeps it awake (no cold starts). `--max-replicas 1` matters: sessions and the dashboard live in memory, so there must be exactly one copy.

The URL, any time:

```bash
az containerapp show -n buildsight -g buildsight --query properties.configuration.ingress.fqdn -o tsv
```

## 4. Check it

- `https://<host>/healthz` shows `"status": "ok"` (open even when locked)
- `https://<host>/` asks for the passcode once per device, then opens BuildSight
- `https://<host>/api/config` (after unlocking) shows `"claude_configured": true` and `"voice_out": "cartesia"`

## 5. Redeploy after a change

Push to `AkhilKarthik143/stepwise`. On the fork's GitHub page click **Sync fork**, wait for the fork's "Build image" action to finish (about 4 minutes), then in Cloud Shell:

```bash
az containerapp update -n buildsight -g buildsight --image ghcr.io/citricice/buildsight:latest --revision-suffix v$(date +%H%M)
```

Secrets and settings are kept. A redeploy restarts the app, which resets the dashboard: don't redeploy right before presenting.

## At the demo table

- Phone: `https://<host>/`
- Dashboard laptop: `https://<host>/#dashboard`
- Live numbers in Azure: portal, Application Insights, **Logs**:
  ```
  traces
  | where message == "turn"
  | summarize median_ms = percentile(toint(customDimensions.ms), 50), turns = count() by kind = tostring(customDimensions.kind)
  ```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red dot on the phone | Open `https://<host>/healthz`. If that fails, read the logs: `az containerapp logs show -n buildsight -g buildsight --follow` |
| Keeps asking for the passcode | Cookies blocked (private browsing), or the passcode changed. Unlock again |
| "No build loaded" | The build wasn't committed before deploying. Commit `build.json` + `steps/`, then redeploy |
| Checks say the Claude key is missing | The secret or env var isn't set. Re-run the step 3 commands |
| Nothing in Application Insights | Wait 2 to 5 minutes, and check the connection string secret |

## Other hosts

The same `Dockerfile` runs on **Render** (Root Directory empty, Dockerfile Path `stepwise/Dockerfile`, Build Context `stepwise`, Health Check `/healthz`; the free plan sleeps after 15 minutes) and **Railway** (`railway.json`). Set the same variables there. For a separate frontend on Vercel, set `VITE_BACKEND_URL` to the backend URL and leave `APP_PASSCODE` unset on the backend, since the lock's cookie only works on one domain.
