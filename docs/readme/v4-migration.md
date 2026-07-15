# Migrate from v3 to v4

v4 is a contract release. It keeps the existing provider registry and OpenCode surfaces, but makes accounting meaning explicit and adds safe, user-configured accounting sources.

## Requirements

- OpenCode `>= 1.4.3`
- Node.js `>= 22`

The OpenCode minimum matches the package's existing `@opencode-ai/plugin` peer range. The Node.js minimum matches `package.json` `engines.node`; build and publish automation use Node.js 24.

## Before you update

1. Close OpenCode.
2. Copy your OpenCode user config and `opencode-quota/quota-toast.json` to a backup location.
3. If another tool reads `opencode-quota show --json` or `quota-export.json`, plan to update it for [JSON export v2](external-integration.md#json-export-v2).
4. Do not move credentials into a project or workspace file. Custom-source credentials remain global or explicit environment variables.

## Update

Run the scoped updater, review its preview, and then confirm:

```bash
npx @slkiser/opencode-quota@latest update
```

Restart OpenCode after the update. Run `/quota`, then `/quota_status`.

The release workflow derives the package version from the release tag. The repository package version is not a separate compatibility switch.

## What changes in v4

### Accounting results and JSON

Rows now separate:

- accounting meaning: quota, rate limit, usage, spend, budget, balance, or status;
- rendering: percentage or value;
- acquisition method; and
- maintained versus user-configured ownership.

`show --json` and the export file use schema `version: 2`. Every row includes the provider-neutral accounting metadata and `renderType`. Update integrations before relying on the v4 export. See [External integration](external-integration.md) for the exact shape.

<a id="custom-accounting-sources"></a>

### Custom providers

v4 adds the aggregate provider ID `custom-sources`. Definitions are read only from the canonical global file:

```text
<OpenCode user config dir>/opencode-quota/quota-toast.json
```

Usually this is `~/.config/opencode/opencode-quota/quota-toast.json`. If `OPENCODE_CONFIG_DIR` is set, use that directory.

A minimal OpenRouter example is:

```jsonc
{
  "enabledProviders": ["custom-sources"],
  "customSources": [
    {
      "id": "openrouter-primary",
      "providerId": "openrouter",
      "label": "OpenRouter Primary",
      "url": "https://openrouter.ai/api/v1/key",
      "preset": "openrouter-key-v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
    },
  ],
}
```

Only `accounting-v1` and `openrouter-key-v1` are supported presets. `providerId` must exactly match an OpenCode runtime provider ID. Definitions keep file order and partial failures do not hide successful sources.

There is no legacy custom-source reader, automatic migration, workspace source definition, executable mapping, or compatibility shim. Invalid or overlapping definitions reject the whole `customSources` array. See [Configuration](configuration.md#custom-accounting-sources) and [Providers](providers.md#custom-accounting-sources) for the complete schema and response contracts.

### Existing settings

v4 does not remove unrelated released configuration inputs. Existing `experimental.quotaToast` settings still work when no sidecar file exists. The custom `customSources` array is the global-only exception and is never read from the legacy block or workspace files.

## Verify every surface

After restarting OpenCode:

1. Run `/quota`; confirm percentage and value rows appear in configured order.
2. Run `/quota_status`; confirm each custom source has the expected provider ID, preset, selection, credential category, and live outcome. URLs and credential values should not appear.
3. Trigger a configured toast lifecycle event, such as waiting for `session.idle`; confirm successful rows remain visible if one source fails.
4. In the TUI session sidebar, expand `Quota`; confirm the same rows and partial error appear.
5. Confirm the compact quota text appears at home bottom and below the session prompt when both placements are enabled.
6. If you use both styles, test `formatStyle: "allWindows"` and `formatStyle: "singleWindow"`. `allWindows` keeps all source rows; `singleWindow` keeps each source's limiting percentage or first value.

## Roll back

1. Close OpenCode.
2. Restore the config backup created before the update.
3. Pin both server and TUI plugin entries to the required v3 release, for example `@slkiser/opencode-quota@3`.
4. Remove or disable `custom-sources`; v3 does not understand v4 custom-source definitions or JSON export v2.
5. Restart OpenCode and run the v3 `/quota` and `/quota_status` checks available in that release.

Do not expect v3 to read v4 cache or custom-source data. The v4 cache is version-bounded and can be regenerated after returning to v4.
