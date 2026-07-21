[← Back to README](../../README.md)

# Move from v3 to v4

v4 adds clearer quota results, guided custom-provider setup, and JSON export v2. The updater keeps unrelated OpenCode settings.

## Requirements

- OpenCode 1.4.3 or newer
- Node.js 22 or newer

## Before you update

1. Close OpenCode.
2. Back up the OpenCode config files you use:
   - `opencode.json` or `opencode.jsonc`
   - `tui.json` or `tui.jsonc`
   - `opencode-quota/quota-toast.json` or `quota-toast.jsonc`
3. If another app reads `opencode-quota show --json` or `quota-export.json`, review [JSON export v2](external-integration.md#json-export-v2).
4. Keep provider credentials in OpenCode authentication, global config, or environment variables—not project quota settings.

## Update

Preview the changes first:

```bash
npx @slkiser/opencode-quota@latest update --dry-run
```

If the preview looks right, apply them:

```bash
npx @slkiser/opencode-quota@latest update
```

Restart OpenCode, then run `/quota` and `/quota_status`.

## What may need your attention

### Custom providers

v4 replaces the old `customSources` setting with `quotaProviders`. The old setting is not read or converted automatically.

Use the guided command to add each custom provider:

```bash
npx @slkiser/opencode-quota@latest provider add
```

It previews the exact global config change and asks before writing. See the [Provider setup guide](providers.md#custom-providers) for full details.

### Apps that read quota JSON

v4 JSON uses schema `version: 2`. It clearly labels quota, usage, spend, budget, balance, and partial failures.

Update any app or script that reads the JSON before depending on v4 output. See [External integration](external-integration.md).

### Alibaba and Qwen custom limits

Built-in limits continue to work. If you changed Alibaba or Qwen limits, add those changes through `quotaProviders`. See [Custom providers](configuration.md#custom-providers).

## Check the update

After restarting OpenCode:

1. Run `/quota` and confirm your providers and values appear.
2. Run `/quota_status` and check for setup or authentication errors.
3. If enabled, check the TUI sidebar, toast, and compact line.
4. If you added a custom provider, confirm its row appears. One failed provider should not hide successful providers.

## Roll back to v3

1. Close OpenCode.
2. Restore the config backup you made before updating.
3. Pin both the server and TUI plugin entries to v3, for example `@slkiser/opencode-quota@3`.
4. Remove v4 `quotaProviders` entries because v3 does not understand them.
5. Restart OpenCode and run `/quota`.

v3 does not read v4 cache or custom-provider state. OpenCode Quota can recreate those files if you return to v4.
