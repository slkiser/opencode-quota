# OpenCode Quota Dashboard

Historical tracking for API quota usage over time — burn-down, model cost breakdown, and weekly reset history.

**The UI is the menubar app** (`opencode-quota gui` → History tab), not a browser page. There is no web dashboard UI anymore — maintaining a second UI in parallel with the menubar, both reading the same SQLite database, wasn't worth it once the menubar already showed live quota. The standalone HTTP server still exists as a **headless JSON API only**, for programmatic access without running Electron at all.

## Features

- **Live Quota Cards** — Real-time quota status for all enabled providers (Anthropic, OpenAI, DeepSeek, etc.), in the menubar's Dashboard tab
- **History tab (menubar)** — Burn-down sparkline, model cost breakdown, and weekly reset history, rendered natively in the popup
- **Headless JSON API** — The same historical data via HTTP, for scripts/automation that don't want to launch the Electron app

## Quick Start

1. **Install dependencies:**
   ```bash
   cd /Users/thanhndv212/Develop/opencode-quota
   pnpm install
   ```

2. **Build the project:**
   ```bash
   pnpm run build
   pnpm run build:gui
   ```

3. **View quota history (UI):**
   ```bash
   opencode-quota gui
   ```
   Click the tray icon → **History** tab.

4. **Or query the headless API (no UI):**
   ```bash
   opencode-quota dashboard
   curl http://localhost:3939/api/dashboard/summary?providers=anthropic&days=7
   ```

## Architecture

### Database Schema

The dashboard uses SQLite for persistent historical tracking:

- **quota_snapshots** — Captured every 5 minutes, stores provider quota data
- **usage_history** — Daily aggregated usage by provider/model (tokens, cost, requests)
- **weekly_resets** — Records quota reset events with utilization metrics

Database location: `~/.local/share/opencode/quota-dashboard.db` (alongside main OpenCode DB)

### Components

| File | Purpose |
|------|---------|
| `src/dashboard/schema.sql` | Database schema (4 tables incl. `schema_version`) |
| `src/dashboard/db-migrate.ts` | Schema migration logic |
| `src/dashboard/api.ts` | `DashboardApi` class (SQLite operations) |
| `src/dashboard/server.ts` | Express **JSON API only** (port 3939, no static files served) |
| `src/dashboard/quota-snapshot-bridge.ts` | Captures snapshots/resets as a side effect of the existing toast/status fetch |
| `src/dashboard/usage-history-bridge.ts` | Syncs `usage_history` from `aggregateUsage()` |
| `src/dashboard/bun-sqlite-database.ts` / `sqljs-database.ts` | Bun / Electron-compatible read adapters (see [Database Drivers](dashboard-technical-spec.md#database-drivers-as-built)) |
| `src/bin/dashboard.ts` | Headless API-server CLI entry point |
| `src/gui/ipc/dashboard-history.ts` | Menubar IPC handlers reading `DashboardApi` directly (no HTTP) for the History tab |
| `src/gui/renderer/app.js` (History tab) | The actual UI: burn-down sparkline, model cost bars, reset list |

### API Endpoints

- `GET /api/dashboard/summary?providers=anthropic,openai&days=7`
  - Returns: Current quota, history, model breakdown, resets for all providers
- `GET /api/dashboard/quota-history/:provider?days=7`
  - Returns: Historical quota snapshots for burn-down chart
- `GET /api/dashboard/usage-breakdown/:provider?days=7`
  - Returns: Per-model usage aggregation (tokens, cost, requests)

## Background Snapshot Capture

There is no timer/interval-based snapshot service. `captureDashboardSnapshotsBestEffort()` in `src/plugin.ts` runs as a side effect whenever the plugin's existing toast/status-fetch path already pulls quota data (`session.idle` / `session.compacted`) — reusing data already fetched rather than polling on its own schedule. `quota-snapshot-bridge.ts` turns that data into `quota_snapshots`/`weekly_resets` rows; `usage-history-bridge.ts` syncs `usage_history` from `aggregateUsage()`. All of this is best-effort and never blocks or fails the toast itself.

## Development

### Local Testing

```bash
# Terminal 1: Start dashboard server
pnpm run build
node dist/bin/dashboard.js --port 3939

# Terminal 2: Trigger OpenCode sessions to generate usage data
# (query the API again once quota snapshots have been captured)
curl http://localhost:3939/api/dashboard/providers
```

### Custom Port

```bash
opencode-quota dashboard --port 4000
```

### Debugging

- **No data showing?** Ensure you've run some AI sessions so quota providers have data to report.
- **Server won't start?** Check that port 3939 (or custom port) is not already in use: `lsof -i :3939`
- **Express not found?** Run `pnpm install` to install dependencies.
- **History tab empty in the menubar app?** Same root cause as above — no snapshots captured yet. The tab reads the DB directly (no server needed), so it's unaffected by whether the headless API server is running.

## Troubleshooting

### Error: "Express not installed"

```bash
pnpm install express @types/express
```

### Error: "Database is locked"

Another process (like the OpenCode server plugin) may be using the DB. Stop conflicting processes or use a separate DB path:

```typescript
const dashboardDbPath = join(homedir(), '.local/share/opencode/quota-dashboard-standalone.db');
```

## Future Enhancements

- [ ] Export dashboard data as CSV/JSON
- [ ] Cost alerts (email/Slack when threshold exceeded)
- [ ] Multi-workspace support (track quotas across projects)
- [ ] Prometheus metrics endpoint for observability

## License

MIT (same as parent project)
