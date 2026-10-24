# Deploying BuildSight on Azure

One container on **Azure Container Apps** runs the whole app: pages, API routes, Claude and Cartesia calls. **Application Insights** records requests and errors. An optional **passcode** keeps strangers with the link from spending the API keys.

GitHub Actions (`.github/workflows/image.yml`) builds the image on every push to `stepwise` and publishes it to `ghcr.io/citricice/buildsight`. Azure only pulls it: its own builder (ACR Tasks) is blocked on student subscriptions. The image holds code only, never keys.

## Redeploy after a change (the app already exists)

1. Push to `stepwise` on github.com/CitricIce/stepwise.
2. Wait for the **Build image** action to show a green check (about 3 minutes).
3. In Azure Cloud Shell:

```bash
az containerapp update -n buildsight -g buildsight \
  --image ghcr.io/citricice/buildsight:$(git ls-remote https://github.com/CitricIce/stepwise refs/heads/stepwise | cut -f1)
```

This deploys the image tagged with the latest commit. Don't use `:latest` here: the name wouldn't change, so Azure wouldn't pull the new image, and express environments refuse `--revision-suffix`. If it says the image isn't found, the build hasn't finished yet.

Secrets and settings are kept. A redeploy restarts the app; don't do it right before presenting.

## First-time setup (already done for buildsight)

Once: make the package public (GitHub, your profile, Packages, buildsight, Package settings, Change visibility, Public).

```bash
az extension add --name containerapp --upgrade
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Insights; do az provider register --namespace $ns; done
az containerapp up --name buildsight --resource-group buildsight --location westus2 \
  --image ghcr.io/citricice/buildsight:latest --ingress external --target-port 8000

az monitor app-insights component create --app buildsight-insights -g buildsight --location westus2
az monitor app-insights component show --app buildsight-insights -g buildsight --query connectionString -o tsv
```

Then the keys, typed in Cloud Shell only:

```bash
az containerapp secret set -n buildsight -g buildsight --secrets \
  anthropic-key=<ANTHROPIC_API_KEY> cartesia-key=<CARTESIA_API_KEY> \
  app-passcode=<team passcode> insights="<connection string>"

az containerapp update -n buildsight -g buildsight --min-replicas 1 --max-replicas 1 \
  --set-env-vars ANTHROPIC_API_KEY=secretref:anthropic-key CARTESIA_API_KEY=secretref:cartesia-key \
    APP_PASSCODE=secretref:app-passcode APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:insights \
    CARTESIA_VOICE_ID=ef191366-f52f-447a-a398-ed8c0f2943a1 CARTESIA_TTS_MODEL=sonic-3.6
```

`--min-replicas 1` keeps it awake, so there are no cold starts.

To drop the passcode lock: `az containerapp update -n buildsight -g buildsight --remove-env-vars APP_PASSCODE`

## Check it

- `https://<host>/api/health` (open even when locked) shows `"claude": "anthropic"` and `"voice": "cartesia"`. `"missing"` or `"browser"` means that key isn't set.
- `https://<host>/` asks for the passcode once per device, then opens the hub.
- On the build screen, tap **Mic**. It should say **Listening**, not "Listening (browser)".

The URL, any time:

```bash
az containerapp show -n buildsight -g buildsight --query properties.configuration.ingress.fqdn -o tsv
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page won't load | Open `/api/health`. If that fails too, check the revision in the portal: Container App, Revisions and replicas |
| Keeps asking for the passcode | Cookies blocked (private browsing), or the passcode changed. Unlock again |
| `/api/health` says `"claude": "missing"` | The secret or env var isn't set. Re-run the key commands |
| Mic says "Listening (browser)" | Cartesia key missing, or Cartesia refused it. `/api/health` shows which |
| No voice on iPhone | Turn off silent mode, then tap any button once so Safari allows audio |
| Logs | Portal, buildsight-insights, Logs: `traces \| order by timestamp desc \| take 50` (`az containerapp logs` doesn't work on express environments) |
