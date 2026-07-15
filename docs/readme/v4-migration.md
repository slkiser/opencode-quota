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
4. Do not move credentials into a project or workspace file. Quota-provider credentials remain trusted global, OpenCode `auth.json`, or explicit environment variables.

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

### Custom providers

v4 adds the ordered global `quotaProviders` array and aggregate provider ID `quota-providers`. Maintain it in the supported global OpenCode config surface:

```text
<OpenCode user config dir>/opencode.jsonc
```

Strict JSON `opencode.json` is also supported. The recommended guided flow is:

```bash
npx @slkiser/opencode-quota@latest provider add
```

It previews the exact global file, never asks for credentials, defaults new files to commented JSONC, and preserves existing strict JSON.

A minimal OpenRouter definition is:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "quotaProviders": [
        {
          "id": "openrouter-primary",
          "providerId": "openrouter",
          "label": "OpenRouter Primary",
          "mode": "remote-api",
          "url": "https://openrouter.ai/api/v1/key",
          "format": "openrouter-key-v1",
          "apiKeyEnv": "OPENROUTER_API_KEY",
        },
      ],
    },
  },
}
```

Exactly two modes exist: `remote-api` and `local-estimate`. Only `accounting-v1` and `openrouter-key-v1` are supported remote formats. Stable `id` defaults the matching OpenCode provider identity; use `providerId` only when it differs. Definitions keep file order and partial failures do not hide successful definitions.

The old public `customSources` property was removed and is rejected. There is no compatibility reader, alias, automatic migration, workspace quota-provider definition, executable mapping, or compatibility shim. Project OpenCode provider/model declarations remain read-only matching inputs only. See [Configuration](configuration.md#custom-providers) and [Providers](providers.md#custom-providers).

### Existing settings

v4 keeps unrelated released configuration inputs. Existing global and project quota settings retain their normal layering, but `quotaProviders` is global-only. The standalone `alibabaCodingPlanTier` path was removed; maintained Alibaba and Qwen limits use reserved `quotaProviders` definitions.

## Verify every surface

After restarting OpenCode:

1. Run `/quota`; confirm percentage and value rows appear in configured order.
2. Run `/quota_status`; confirm each definition has the expected provider ID, mode/format, state path or credential category, and live outcome. URLs, counter contents, and credential values should not appear.
3. Trigger a configured toast lifecycle event, such as waiting for `session.idle`; confirm successful rows remain visible if one definition fails.
4. In the TUI session sidebar, expand `Quota`; confirm the same rows and partial error appear.
5. Confirm the compact quota text appears at home bottom and below the session prompt when both placements are enabled.
6. If you use both styles, test `formatStyle: "allWindows"` and `formatStyle: "singleWindow"`. `allWindows` keeps all definition rows; `singleWindow` keeps each definition's limiting percentage or first value.

## Roll back

1. Close OpenCode.
2. Restore the config backup created before the update.
3. Pin both server and TUI plugin entries to the required v3 release, for example `@slkiser/opencode-quota@3`.
4. Remove or disable `quota-providers`; v3 does not understand v4 `quotaProviders` definitions or JSON export v2.
5. Restart OpenCode and run the v3 `/quota` and `/quota_status` checks available in that release.

Do not expect v3 to read v4 cache or quota-provider state. The v4 cache and generated counters are version-bounded and can be regenerated after returning to v4.
