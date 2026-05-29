# CoVibes Privacy Policy

## What data CoVibes collects

CoVibes collects **anonymous, aggregated usage statistics** to help improve the product. Telemetry is **off by default** and must be explicitly enabled by the user via `covibes.telemetry.enabled: true` in VS Code settings.

When telemetry is enabled, CoVibes may collect:

| Event               | Data                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `session_start`     | Number of participants (integer)                                  |
| `sync_latency_high` | Sync latency in milliseconds when above 300ms threshold           |
| `error`             | Error code string (e.g. `RelayUnreachable`)                       |

## What CoVibes never collects

- File contents, file names, or file paths
- Repository URLs or remote URLs
- Commit messages or code changes
- Display names, user IDs, or any personally-identifying information
- API keys, agent configurations, or authentication tokens

## How data is stored

Anonymous events are sent to a self-hosted Sentry instance. Raw events are retained for 30 days and then automatically deleted. Aggregated metrics may be retained longer for trend analysis.

## How to disable telemetry

Set `covibes.telemetry.enabled` to `false` in VS Code Settings (it defaults to `false`). VS Code's global telemetry setting (`telemetry.telemetryLevel`) is also respected — if it is set to `off`, CoVibes will not send any telemetry regardless of the CoVibes-specific setting.

## Contact

Questions? Open an issue at https://github.com/covibes/covibes/issues.
