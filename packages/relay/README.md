# @covibes/relay

WebSocket relay server for CoVibes. Routes real-time collaboration messages between VS Code extension clients. No content is stored — it is a stateless message bus.

WebSocket upgrade and session management are implemented in subsequent tasks (2.2–2.4).

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
| `/ws`      | GET (upgrade) | WebSocket endpoint — implemented in Task 2.2       |

---

## Deploy

See `fly.toml` for Fly.io configuration. Redis is attached as an Upstash add-on in Task 2.7.
