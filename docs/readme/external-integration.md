# External integration

[← Back to README](../../README.md)

Use this when another tool needs quota data: shell scripts, tmux, Starship, CI, status bars, or routers.

There are two ways to get the same JSON data:

| Use this                     | When you want                                                               |
| ---------------------------- | --------------------------------------------------------------------------- |
| `opencode-quota show --json` | A command that prints quota JSON now                                        |
| Export file                  | A file other tools can read repeatedly without running a command every time |

Both use the local provider cache. They do **not** make extra provider network requests.

## JSON export v2

Both surfaces emit schema `version: 2`. Provider entries stay flat. Every row includes `resultType`, `renderType`, acquisition/ownership/authority metadata, and its percent or value payload. Custom-provider rows also include `sourceId`; the `custom-sources` provider adds an ordered `sources` array with coarse `ok`, `error`, or `unavailable` status.

Detailed custom-provider outcomes, credential category, environment name, and checked paths are intentionally excluded from public JSON. Use `/quota_status` for those live diagnostics. Export and CLI JSON remain cache-only.

## Option 1: print JSON now

```bash
opencode-quota show --json
```

Common variants:

```bash
# One provider only
opencode-quota show --json --provider copilot

# Fail if comparable cached quota is below 5%
opencode-quota show --json --threshold 5
```

Threshold exits:

| Exit | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | Quota is available and above the threshold                     |
| `1`  | At least one comparable cached provider is below the threshold |
| `2`  | No cached percentage was available to compare                  |

## Option 2: write an export file

Use this when a status bar or background tool reads quota often.

Add this to `opencode-quota/quota-toast.json`:

```jsonc
{
  "export": {
    "enabled": true,
  },
}
```

Default output path:

```text
$XDG_CACHE_HOME/opencode/quota-export.json
```

Usually that means:

```text
~/.cache/opencode/quota-export.json
```

The TUI updates this file after each home-bottom background refresh, about every 60 seconds. Write errors are logged as warnings and never break TUI rendering.

## Copy-paste examples

### CI: stop when quota is low

```bash
npx @slkiser/opencode-quota show --json --threshold 5
```

### Shell: branch on Copilot quota

```bash
PCT=$(opencode-quota show --json | jq '.providers["copilot"].entries[0].percentRemaining')
(( ${PCT%.*} < 10 )) && echo "Low quota, skipping." && exit 0
```

### tmux: read the export file

```bash
set -g status-interval 30
set -g status-right '#(jq -r "[.providers|to_entries[]|select(.value.status==\"ok\")|(.value.entries[0].percentRemaining|floor|tostring)+\"%\"]|join(\" · \")" ~/.cache/opencode/quota-export.json 2>/dev/null)'
```

### Starship: run the JSON command

```toml
[custom.quota]
command = "opencode-quota show --json 2>/dev/null | jq -r '[.providers|to_entries[]|select(.value.status==\"ok\")|(.value.entries[0].percentRemaining|floor|tostring)+\"%\"]|join(\" \")'"
when = "true"
interval = 60
```

<details>
<summary><strong>JSON shape</strong></summary>

Both `show --json` and the export file use this v2 structure:

```jsonc
{
  "version": 2,
  "exportedAt": 1748736000,
  "fromCache": true,
  "cacheAgeSeconds": 42,
  "providers": {
    "copilot": {
      "status": "ok",
      "fetchedAt": 1748735958,
      "entries": [
        {
          "name": "Premium Requests",
          "resultType": "quota",
          "acquisitionMethod": "remote_api",
          "ownership": "maintained",
          "authority": "provider_reported",
          "window": "Monthly",
          "resetAt": 1748908800,
          "renderType": "percent",
          "percentRemaining": 62.3,
        },
      ],
    },
    "custom-sources": {
      "status": "ok",
      "fetchedAt": 1748735958,
      "entries": [
        {
          "name": "OpenRouter Primary budget",
          "resultType": "budget",
          "acquisitionMethod": "remote_api",
          "ownership": "user_configured",
          "authority": "provider_reported",
          "sourceId": "openrouter-primary",
          "renderType": "percent",
          "percentRemaining": 40,
        },
      ],
      "sources": [
        {
          "id": "openrouter-primary",
          "providerId": "openrouter",
          "status": "ok",
          "entryCount": 1,
        },
        {
          "id": "internal-accounting",
          "providerId": "internal_gateway",
          "status": "error",
          "entryCount": 0,
        },
        {
          "id": "model-specific",
          "providerId": "internal_gateway",
          "status": "unavailable",
          "entryCount": 0,
        },
      ],
    },
    "opencode-go": {
      "status": "error",
      "fetchedAt": 1748735958,
      "error": "Request timeout after 5s",
    },
    "anthropic": {
      "status": "unavailable",
    },
  },
}
```

Provider and source statuses:

| Value         | Meaning                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`          | Cached rows exist. A custom aggregate can remain `ok` while another source has `error`.                                                                          |
| `error`       | The cached provider/source failed and has no successful row. Provider-level errors include a sanitized message; source statuses do not expose detailed outcomes. |
| `unavailable` | No matching cached data exists. For a custom source this also covers an exact runtime `providerId` that was unavailable when the aggregate cache was written.    |

Entry fields:

- `renderType: "percent"` uses `percentRemaining`; `renderType: "value"` uses `value`.
- `resultType` is one of `quota`, `rate_limit`, `usage`, `spend`, `budget`, `balance`, or `status`.
- `window`, `resetAt`, and `observedAt` appear only when source data supplies them.
- `sourceId` appears on rows stamped by an aggregate source; it is identity, not a display label.
- `sources` preserves configured source order. Each summary is exactly `id`, `providerId`, coarse `status`, and `entryCount`; the count is the cached normalized row count for that source, and duplicate labels remain separate by `id`.

</details>

<details>
<summary><strong>More integration ideas</strong></summary>

### File watcher: refresh only when the export changes

```bash
# macOS
fswatch -o ~/.cache/opencode/quota-export.json | xargs -I{} my-status-refresh

# Linux
inotifywait -m -e close_write ~/.cache/opencode/quota-export.json \
  | while read; do my-status-refresh; done
```

### Router: pick the provider with the most headroom

```python
import json, subprocess

data = json.loads(subprocess.check_output(
    ["opencode-quota", "show", "--json"], timeout=1
))
best = max(
    (k for k, v in data["providers"].items() if v["status"] == "ok"),
    key=lambda k: next(
        (e.get("percentRemaining", 0) for e in data["providers"][k]["entries"]), 0
    ),
    default=None,
)
```

</details>
