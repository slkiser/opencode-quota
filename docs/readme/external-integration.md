[← Back to README](../../README.md)

# Use quota data in other tools

OpenCode Quota can share its cached quota data with scripts, status bars, CI, and monitoring tools. None of these options make extra provider requests.

| What you need | Use |
| --- | --- |
| Run a command and get JSON | `opencode-quota show --json` |
| Read the same JSON often | Export file |
| Send numbers to a monitoring system | OpenTelemetry metrics |

## 1. Get JSON from a command

Use this for scripts and CI:

```bash
opencode-quota show --json
```

It works with OpenCode closed: it reads the quota OpenCode saved last and never asks a provider. See [Terminal commands](troubleshooting.md#terminal-commands).

```bash
# Only Copilot
opencode-quota show --json --provider copilot

# Exit with an error when comparable quota is below 5% (for example in CI)
npx @slkiser/opencode-quota show --json --threshold 5
```

`--threshold` exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Results are complete and none is below the threshold |
| `1` | At least one comparable cached percentage is below the threshold, or the command failed |
| `2` | Results were incomplete or no comparable percentage was found |

### Read Copilot's percentage with `jq`

Some Copilot rows are values, not percentages, so select a percentage row instead of taking the first one:

```bash
opencode-quota show --json --provider copilot \
  | jq -r '(.providers.copilot.entries? // []) | map(select(.renderType == "percent" and .percentRemaining != null)) | first | .percentRemaining // empty'
```

## 2. Read an export file

Use this for a status bar or another tool that checks quota often. In the TUI, turn on "Quota file (JSON)" on the Plugin tab (`/quota_status`). Or add this to `opencode-quota/settings.jsonc` ([where](configuration.md#where-settings-live)):

```jsonc
{ "system": { "exportFile": true } }
```

- The file is `~/.cache/opencode/quota-export.json` (or `$XDG_CACHE_HOME/opencode/quota-export.json` when `XDG_CACHE_HOME` is set). `system.exportPath` changes it.
- OpenCode's background service rewrites it each time its quota snapshot changes. The file keeps its last contents when OpenCode stops.
- After a model step, the plugin may check providers again once 30 seconds have passed since the last check, even when that is sooner than `providers.checking.minIntervalMs`.
- The quota window's Limits tab (the TUI's `/quota`) asks providers right away.
- Web and Desktop `/quota` use `poll` refreshes and wait out `providers.checking.minIntervalMs`.
- A write error is logged but never breaks the TUI.

### tmux example (add to your tmux config)

```bash
set -g status-interval 30
set -g status-right '#(jq -r "[.providers|to_entries[]|select(.value.status==\"ok\")|first(.value.entries[]?|select(.renderType==\"percent\" and .percentRemaining!=null))|(.percentRemaining|floor|tostring)+\"%\"]|join(\" | \")" ~/.cache/opencode/quota-export.json 2>/dev/null)'
```

### Starship example (add to `starship.toml`)

```toml
[custom.quota]
command = "jq -r '[.providers|to_entries[]|select(.value.status==\"ok\")|first(.value.entries[]?|select(.renderType==\"percent\" and .percentRemaining!=null))|(.percentRemaining|floor|tostring)+\"%\"]|join(\" \")' ~/.cache/opencode/quota-export.json 2>/dev/null"
when = "true"
interval = 60
```

## 3. Send OpenTelemetry metrics

Use this only when OpenCode's server process (normally the background service) already has an OpenTelemetry metrics provider and exporter. OpenCode Quota does not create or configure them. In the TUI, turn on "OpenTelemetry metrics" on the Plugin tab (`/quota_status`). Or add this to `opencode-quota/settings.jsonc` ([where](configuration.md#where-settings-live)):

```jsonc
{ "system": { "telemetry": true } }
```

OpenCode Quota then publishes two gauges:

| Metric | Meaning |
| --- | --- |
| `opencode.quota.consumed` | Used quota from `0` to `1` |
| `opencode.quota.cache.age` | Age of cached data in seconds |

It reads results already in memory and never starts its own refresh loop. If the host has no global metrics provider, nothing is sent and OpenCode Quota keeps working normally.

<details>
<summary><strong>Metric fields and privacy</strong></summary>

`opencode.quota.consumed` uses percentage rows only. Its value is `(100 - percentRemaining) / 100`, limited to the range `0` to `1`. Rows without a percentage (amounts, yes/no values, text) feed neither gauge.

| Metric | Labels |
| --- | --- |
| `opencode.quota.consumed` | `quota.provider`, `quota.result_type`, `quota.window` |
| `opencode.quota.cache.age` | `quota.provider` |

Label values stay limited:

- `quota.provider` is a maintained provider ID, `custom`, or `other`.
- `quota.result_type` is `quota` (rate limits too), `usage` (spending too), `budget`, `balance`, or `status`.
- `quota.window` is `rpm`, `hour`, `five_hour`, `session`, `day`, `week`, `month`, `year`, `mcp`, `code_review`, or `unknown`.

When several rows map to the same safe labels, OpenCode Quota reports the highest consumed ratio or oldest cache age. Display names, account IDs, configured source IDs, credentials, URLs, paths, errors, and raw responses are never labels.

</details>

<details>
<summary><strong>Minimal host setup example</strong></summary>

Register the provider before OpenCode loads OpenCode Quota. Replace the console exporter with your real exporter.

```javascript
import { metrics } from "@opentelemetry/api";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

const reader = new PeriodicExportingMetricReader({
  exporter: new ConsoleMetricExporter(),
  exportIntervalMillis: 60_000,
});
const provider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(provider);

export async function shutdownMetrics() {
  await provider.shutdown();
}
```

</details>

## JSON basics

The command and export file both use JSON schema version `3`. Every provider has a `status`, and the other fields depend on it:

| Status | Meaning | Fields |
| --- | --- | --- |
| `ok` | Data is available | `fetchedAt`, `entries` |
| `partial` | Some data worked and some failed | `fetchedAt`, `entries`, `errors` |
| `error` | The provider failed | `fetchedAt`, a safe `error` message |
| `unavailable` | Not set up, or no saved data | none required |

A percentage entry uses `renderType: "percent"` and `percentRemaining`. A value entry uses `renderType: "value"` and `value`: the value text the TUI shows (for example, `$12.50 left` or `$2.50/$10.00`), and `Enabled` or `Disabled` for a yes/no row.

- Scripts must not assume the first row is a percentage or that a provider has only one row. Select `renderType`, `resultType`, and any other field you need.
- The `words` settings never change JSON. It has every row, so supplementary rows can add more value entries.
- Version 3 does not expose row prominence or separate used, limit, and remaining amounts.
- Threshold checks use percentage rows only.

Every entry has these fields:

| Field | Meaning |
| --- | --- |
| `id` | The row's stable id, `provider.key` (for example `copilot.allowance`), the same id the TUI's hide, rename and order settings use. The rows of two accounts of one provider share it; `account` tells them apart. |
| `name` | `Provider (account) Label`, for example `Copilot (pro) Premium requests` |
| `resultType` | `quota` (rate limits too), `usage` (spending too), `budget`, `balance`, or `status` |
| `acquisitionMethod` | `remote_api`, `dashboard_scrape`, `local_cli`, or `local_estimation` |
| `ownership` | `maintained`, or `user_configured` for rows from `providers.custom` |
| `authority` | `provider_reported` or `locally_derived` |

Optional entry fields are `account`, `window` (for example `5h`, `Weekly`, `Monthly`) and `resetAt` (Unix seconds). `account` is the account the TUI shows, for example `pro`; two logins with the same account get `pro` and `pro 2`, in the export file, `show --json` and the TUI alike. A provider's `error` (and each `errors` message) is the short error text the TUI shows, for example `Sign in again` or `Provider error 503`.

The export file writes each provider's last check, a failed one too. `show --json`, and the export file for a provider not checked since OpenCode's background service started, write the quota OpenCode saved last. Rows from `providers.custom` appear under `providers["quota-providers"]`; after a check, that result also has a `sources` list with each definition's coarse status.

Treat `status: "partial"` as incomplete.

Secrets, credentials, URLs, checked paths, and raw provider responses remain excluded from public JSON. Use `/quota_status` for live diagnostics.

<details>
<summary><strong>Configured source details</strong></summary>

Rows from a `providers.custom` definition appear under `providers["quota-providers"]`. Their `id` is `quota-providers.custom.<definition id>.<key>`, so tools can match each row to its definition:

```json
{
  "id": "quota-providers.custom.openrouter-primary.Monthly",
  "name": "Custom providers (OpenRouter primary) Monthly",
  "account": "OpenRouter primary",
  "renderType": "percent",
  "percentRemaining": 40
}
```

The provider also includes a summary for every configured source except the built-in tunings:

```json
"sources": [
  {
    "id": "openrouter-primary",
    "providerId": "openrouter",
    "status": "ok",
    "entryCount": 1
  }
]
```

Each summary is exactly `id`, effective `providerId`, coarse `status`, and `entryCount`. A switched-off definition is never checked, so its summary has `"enabled": false` instead of a `status`, and `entryCount` is `0`. A source can be `ok` after producing valid rows while failed mapping candidates can still make the aggregate provider `partial`.

</details>

<details>
<summary><strong>Small JSON example</strong></summary>

```json
{
  "version": 3,
  "exportedAt": 1748736000,
  "fromCache": true,
  "cacheAgeSeconds": 42,
  "providers": {
    "copilot": {
      "status": "ok",
      "fetchedAt": 1748735958,
      "entries": [
        {
          "id": "copilot.allowance",
          "name": "Copilot (pro) Premium requests",
          "account": "pro",
          "resultType": "quota",
          "acquisitionMethod": "remote_api",
          "ownership": "maintained",
          "authority": "provider_reported",
          "renderType": "percent",
          "percentRemaining": 62.3
        }
      ]
    }
  }
}
```

</details>
