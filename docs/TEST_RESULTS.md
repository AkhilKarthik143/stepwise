# FORGE AR test results

## Baseline before integration

| Area | Command | Result |
| --- | --- | --- |
| FORGE backend | `cd forge/backend && pytest -q` | Blocked at collection: `pydantic_settings` missing in host Python 3.14 |
| FORGE frontend | `cd forge/frontend && npm run build` | Passed |
| AR backend | `cd ar-donor && pytest -q` | Blocked at collection: `notebooklm` missing |
| AR frontend | `cd ar-donor/web && npm run typecheck` | Blocked: donor `node_modules`/`tsc` not installed |

## Integration validation

| Area | Command | Result |
| --- | --- | --- |
| FORGE backend | `cd forge/backend && ../../.venv/bin/python -m pytest -q` | **195 passed**, 1 deprecation warning |
| FORGE frontend | `cd forge/frontend && npm run typecheck` | **Passed** |
| FORGE frontend | `cd forge/frontend && npm run build` | **Passed**; Vite emitted the existing large 3D chunk warning |
| Python syntax | `python3 -m compileall -q forge/backend/app` | **Passed** |
| Mock health | `GET /healthz` with `FORGE_PROVIDER=mock` | **Passed**; `status=ok`, `mock_mode=true` |
| Mock demo | WebSocket text turn + tool/panel events | **Passed**; machine brief and provider status observed |
| AR anchor | WebSocket pending target → `confirm_anchor` → confirmed event | **Passed**; `source=user_confirmed`, `coordinate_system=normalized_1000` |
| Served UI | Browser load of backend root | **Passed**; root serves the mobile-first FORGE AR field console with no browser console errors |
| Physical phone camera | HTTPS/mobile-device run | Not run in this desktop workspace; camera permission/HTTPS steps are documented as a remaining validation item |

The donor repository was not modified. Its baseline remains dependency-blocked on the host (`notebooklm` and donor web `node_modules` were absent); the adapted paths are covered by the FORGE integration tests and build.

## Credential posture

No `ANTHROPIC_API_KEY`, `CARTESIA_API_KEY`, or Moss project credentials were found in the workspace during this run. Live provider validation is therefore explicitly not claimed; mock/local paths are the validation target.
