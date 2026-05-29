# @covibes/relay

The CoVibes relay server — a stateless WebSocket message router with OT sequencing and Redis-backed session persistence.

## Architecture

- **Stateless per-message:** no file content is stored; messages are forwarded in real time
- **OT Sequencer:** per-document version counter assigns a monotonic `serverVersion` to each `doc.delta`; transforms concurrent ops to ensure convergence
- **Session Registry:** in-memory participant list + grace timer, backed by Redis for reconnection across relay restarts
- **Observability:** structured JSON logging (pino), Prometheus metrics at `/metrics`, optional Sentry error tracking

## Running Locally

```bash
# Install dependencies (from repo root)
pnpm install

# Start with hot reload
PORT=3000 pnpm --filter @covibes/relay dev

# Or build and run
pnpm --filter @covibes/relay build
node packages/relay/dist/main.js
```

## Environment Variables

| Variable           | Required | Default      | Description                                                |
| ------------------ | -------- | ------------ | ---------------------------------------------------------- |
| `PORT`             | No       | `3000`       | HTTP/WS listen port                                        |
| `REDIS_URL`        | No       | —            | Redis connection URL; omit for in-memory only              |
| `LOG_LEVEL`        | No       | `info`       | pino log level (`debug`, `info`, `warn`, `error`, `fatal`) |
| `MAX_PARTICIPANTS` | No       | `4`          | Maximum participants per session                           |
| `SESSION_GRACE_MS` | No       | `1800000`    | Grace period before session expires (ms)                   |
| `SENTRY_DSN`       | No       | —            | Sentry DSN for error tracking                              |
| `NODE_ENV`         | No       | `production` | Environment tag                                            |

## Deploying to Fly.io

```bash
fly auth login
fly apps create covibes-relay
fly secrets set REDIS_URL=rediss://...
fly deploy
```

See `fly.toml` for scaling and region configuration.

## Health Checks

- `GET /healthz` — returns `{"status":"ok"}` when server is running
- `GET /readyz` — additionally checks Redis connectivity
- `GET /metrics` — Prometheus metrics

## Scaling

The relay is stateless per-message. For multiple instances, add a Redis pub/sub layer for cross-instance routing. For most workloads, a single Fly.io instance handles 100+ concurrent sessions.

See `RUNBOOK.md` for on-call procedures.
