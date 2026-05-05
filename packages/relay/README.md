# @covibes/relay

WebSocket relay server for CoVibes. Routes real-time collaboration messages between VS Code extension clients. No content is stored — it is a stateless message bus.

---

## Run locally

```bash
# Install deps from repo root
pnpm install

# Required env vars (all optional during scaffold phase)
export PORT=8080
export REDIS_URL=redis://localhost:6379   # optional; required from Task 2.3 onward
export LOG_LEVEL=info                     # fatal|error|warn|info|debug|trace
export MAX_PARTICIPANTS=4                 # 2–16
export SESSION_GRACE_MS=1800000          # ms before an idle session is evicted

# Development (hot-reload)
pnpm --filter @covibes/relay dev

# Production build
pnpm --filter @covibes/relay build
pnpm --filter @covibes/relay start
```

---

## Endpoints

| Path       | Method        | Description                                        |
| ---------- | ------------- | -------------------------------------------------- |
| `/healthz` | GET           | Liveness probe — always 200 once the process is up |
| `/readyz`  | GET           | Readiness probe — 503 if Redis is unreachable      |
| `/ws`      | GET (upgrade) | WebSocket endpoint                                 |

---

## Deploy

The relay is deployed to Fly.io. Configuration lives in `packages/relay/fly.toml`.

### First-time setup

1. Install `flyctl` locally: `brew install flyctl`.
2. `flyctl auth login`.
3. `flyctl launch --no-deploy --copy-config --name covibes-relay --region ord` (skip if the app already exists).
4. Attach Upstash Redis: `flyctl redis create --name covibes-relay-redis` (or via the Fly dashboard). Copy the resulting `REDIS_URL`.
5. Set secrets:
   ```
   flyctl secrets set REDIS_URL='redis://...' --app covibes-relay
   flyctl secrets set SENTRY_DSN='...' --app covibes-relay   # optional
   ```

> `REDIS_URL` and `SENTRY_DSN` are intentionally absent from `fly.toml` — they must be set as Fly secrets, not committed to source control.

### Continuous deployment

Pushes to `main` trigger the `deploy` job in `.github/workflows/ci.yml`. The job runs only after the full `ci` job (lint, typecheck, test, build) passes and is gated by the GitHub Actions `production` environment.

To enforce manual approval before each deploy, go to **repo Settings → Environments → production → Required reviewers** and add the appropriate approvers.

Required GitHub secret: `FLY_API_TOKEN` — generate via `flyctl auth token` and store it under **repo Settings → Secrets and variables → Actions**.

### Manual deploy

```
flyctl deploy --config packages/relay/fly.toml
```

### Monitoring

- Logs: `flyctl logs --app covibes-relay`
- Health: GET `/healthz` (liveness), `/readyz` (readiness — checks Redis connection)
- Metrics: GET `/metrics` exposes Prometheus-format metrics
