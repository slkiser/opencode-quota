[← Back to README](../../README.md)

# Updating

OpenCode 2 installs and updates plugins itself. This updates every outdated plugin, OpenCode Quota included:

```bash
opencode plugin update
```

Then restart OpenCode and run `/quota_status` in a session (or `npx @slkiser/opencode-quota status` in a terminal). To update only this plugin, pass its entry exactly as written in your OpenCode config, for example `opencode plugin update @slkiser/opencode-quota`.

A `settings.jsonc` written by 6.0.0-beta.1 sets every setting, so a later change to a default reaches a setting only after **Reset page** in `/quota_settings` or after you remove its key from the file.

## Moving from 5.x

Update as above; you don't need to edit your settings. On the first start, OpenCode Quota converts the 4.x or 5.x global settings you set (`opencode-quota/quota-toast.jsonc`, or `experimental.quotaToast` in `opencode.json`) into `opencode-quota/settings.jsonc` ([Configuration](configuration.md)) and leaves the old file in place. From then on, only `settings.jsonc` is read. The TUI shows a conversion toast once, and `/quota_status` lists what was converted, what was dropped, and why. Project settings files (`<your-repo>/opencode-quota/quota-toast.jsonc`) are not read; `/quota_status` lists any it finds.

The `init`, `update`, and `provider add` terminal commands are gone; `show` and `status` stay. Use `opencode plugin add @slkiser/opencode-quota` and `opencode plugin update` instead, and ask your agent to add a [custom provider](providers.md#custom-providers).

<details>
<summary><strong>Old <code>/tokens_*</code> commands</strong></summary>

They keep working, for everyone. Turn them off or on with **Old command names** on the Plugin tab (`/quota_status`), or with `"system": { "oldCommands": false }` in `settings.jsonc`. The "/" list in an open TUI shows the change after OpenCode restarts.

| 4.x and 5.x | Same as |
| --- | --- |
| `/tokens_today` | `/quota_usage today` |
| `/tokens_daily` | `/quota_usage 24h` |
| `/tokens_weekly` | `/quota_usage 7d` |
| `/tokens_monthly` | `/quota_usage 30d` |
| `/tokens_all` | `/quota_usage all` |
| `/tokens_session` | `/quota_usage session` |
| `/tokens_session_all` | `/quota_usage session` |
| `/tokens_between <from> <to>` | `/quota_usage between <from> <to>` |
| `/quota_announcements` | The notices on the Plugin tab (`/quota_status`) |
| `/pricing_refresh` | `p` in the Usage tab (`/quota_usage`); once per OpenCode run, prices older than 7 days also download on their own |

</details>

## Moving to OpenCode 2

`5.0.0` and newer run only on OpenCode 2; this version needs OpenCode `2.0.26` or newer. On OpenCode 1, stay on 4.x: `"plugin": ["@slkiser/opencode-quota@4"]`.

1. Install OpenCode 2 ([OpenCode docs](https://opencode.ai/docs/)) and start it once. On first start it copies your old `auth.json` logins into its database, `opencode.db`. It does this only once.
2. In your OpenCode config, change the OpenCode Quota entry to `@slkiser/opencode-quota` (drop any `@4` pin), then restart OpenCode.
3. Run `/quota_status`. If a provider is missing, log in to it again in OpenCode 2 (`/connect`, or `opencode auth login <provider>`).

Your 4.x global settings convert on the first start, as in [Moving from 5.x](#moving-from-5x). On OpenCode 2:

- **Logins come only from OpenCode 2,** never from `auth.json`.
- **Quota runs in OpenCode's background service,** with the service's `PATH` and environment. See [Service environment](troubleshooting.md#service-environment).
- **Web gets the slash commands, but no toasts or panels.** OpenCode Desktop `2.2.0+` also gets an experimental GUI ([README](../../README.md#what-you-get)).
- **OpenCode Zen uses your OpenCode Console sign-in; OpenCode Go uses it or an API key.** See [OpenCode Go](providers.md#opencode-go) and [OpenCode Zen](providers.md#opencode-zen).
