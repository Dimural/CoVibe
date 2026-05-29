# CoVibes Relay — On-Call Runbook

## Health Checks

- `GET /healthz` — basic liveness (HTTP 200 = alive)
- `GET /readyz` — readiness including Redis ping (HTTP 200 = ready)
- `GET /metrics` — Prometheus metrics

## Monitoring

Configure an external monitor (BetterStack, UptimeRobot, or Fly.io built-in) to hit `/healthz` every 60s. Alert threshold: 2 consecutive failures.

Key Prometheus metrics to watch:

- `connections_total` — rate of new connections
- `sessions_active` — current active sessions
- `messages_routed_total` — message throughput
- `dropped_for_backpressure_total` — should be near zero; spike = slow clients

## Deploying

### Normal deploy (Fly.io)

```bash
fly deploy --app covibes-relay
```

The relay performs a rolling deploy — new instances start and health-check before old ones stop. Zero-downtime for active sessions (clients reconnect via exponential backoff if their connection drops during restart).

### Rolling back

```bash
# List recent releases
fly releases --app covibes-relay

# Roll back to a specific release
fly deploy --app covibes-relay --image registry.fly.io/covibes-relay:<version>
```

## Scaling

```bash
# Scale horizontally (2 instances)
fly scale count 2 --app covibes-relay

# Scale vertically (if memory pressure)
fly scale vm shared-cpu-2x --app covibes-relay
```

**Note:** Multiple instances require a Redis pub/sub layer for cross-instance message routing. The current implementation uses in-instance routing only — all clients in a session must connect to the same instance. Use Fly.io session-affinity for multi-instance deployments.

## Draining Sessions

Before a planned maintenance window:

1. Set a `DRAIN=true` environment variable (add handling in `main.ts` to stop accepting new WS upgrades)
2. Wait for `sessions_active` to drop to 0 or the grace period to expire
3. Deploy

Currently there is no automatic drain — clients reconnect after restart within the grace period.

## Redis Issues

If Redis is unavailable, the relay falls back to in-memory session storage automatically. Sessions will not persist across relay restarts but the relay remains functional.

Check Redis connectivity:

```bash
fly ssh console --app covibes-relay -C "node -e \"require('ioredis').createClient(process.env.REDIS_URL).ping().then(console.log)\""
```

## Common Alerts

| Alert                                   | Likely cause                      | Fix                                       |
| --------------------------------------- | --------------------------------- | ----------------------------------------- |
| `/healthz` down                         | Relay crashed                     | `fly restart --app covibes-relay`         |
| `sessions_active` stuck high            | Grace timers not expiring         | Check Redis EXPIRE keys; restart if stale |
| `dropped_for_backpressure_total` rising | Slow or unresponsive client       | Client auto-disconnected (code 4413)      |
| High memory usage                       | Large sessions or message backlog | Scale VM; check for stuck connections     |

## Load Testing

Run the load test script against a staging relay before major deploys:

```bash
RELAY_URL=wss://covibes-relay-staging.fly.dev \
SESSIONS=100 PARTICIPANTS=4 OPS_PER_SEC=20 DURATION_MS=60000 \
npx tsx tests/load/load.ts
```

Target: P95 latency < 150ms at 100 sessions × 4 participants × 20 ops/sec.
