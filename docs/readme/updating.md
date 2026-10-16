[← Back to README](../../README.md)

# Updating

OpenCode 2 installs and updates plugins itself. This updates every outdated plugin, OpenCode Quota included:

```bash
opencode plugin update
```

Then restart OpenCode and run `/quota_status` in a session (or `npx @slkiser/opencode-quota status` in a terminal). To update only this plugin, pass its entry exactly as written in your OpenCode config, for example `opencode plugin update @slkiser/opencode-quota`.

## Moving from 5.x

Update as above; you don't need to edit your settings. On the first start, OpenCode Quota converts your old global settings automatically:

- It reads `opencode-quota/quota-toast.jsonc` or `.json` in the global OpenCode folder, or `experimental.quotaToast` in the global `opencode.json` or `opencode.jsonc` when there is no such file.
- When the global OpenCode folder has neither, it reads them in the first older folder 4.x also read that has them: `~/.config/opencode`, on macOS `~/Library/Application Support/opencode`, on Windows `%APPDATA%\opencode` and `%LOCALAPPDATA%\opencode`. With `OPENCODE_CONFIG_DIR` set, it reads only that folder.
- It writes the result to `opencode-quota/settings.jsonc` (see [Configuration](configuration.md)) and leaves the old file in place. From then on, only `settings.jsonc` is read.
- Display choices, words, provider checks and system switches share that file, each in its own section.
- The TUI shows a conversion toast once. `/quota_status` lists what was converted, what was dropped, and why in the server session that performs the conversion.
- Settings you never set use the 6.x defaults: the status line shows only when the sidebar is not on screen, a toast follows a reply only once a limit is getting low, no toast follows a question, toasts use the grouped layout (`toast.layout: "detailed"` is the 5.x look), and the sidebar and toasts show "runs out in" when a limit, used at your pace, runs out before it resets.

Your `/tokens_*` commands keep working; they are on for everyone. Turn them off or on with **Old command names** on the Plugin tab (`/quota_status`), or with `"system": { "oldCommands": false }` in `settings.jsonc`. The "/" list in an open TUI shows the change after OpenCode restarts.

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

Project settings files (`<your-repo>/opencode-quota/quota-toast.jsonc`) are not read; `/quota_status` lists any it finds. Put what you still need in `settings.jsonc`.

The `init`, `update`, and `provider add` terminal commands are gone; `show` and `status` stay:

| Instead of                                 | Use                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `npx @slkiser/opencode-quota init`         | `opencode plugin add @slkiser/opencode-quota`                                                  |
| `npx @slkiser/opencode-quota update`       | `opencode plugin update`                                                                       |
| `npx @slkiser/opencode-quota provider add` | Ask your agent to add a custom provider: see [Custom providers](providers.md#custom-providers) |

## Moving to OpenCode 2

`5.0.0` and newer run only on OpenCode 2; this version needs OpenCode `2.0.26` or newer.

1. Install OpenCode 2 ([OpenCode docs](https://opencode.ai/docs/)) and start it once. On first start it copies your old `auth.json` logins into its database, `opencode.db`. It does this only once.
2. In your OpenCode config, change the OpenCode Quota entry to `@slkiser/opencode-quota` (drop any `@4` pin), then restart OpenCode.
3. Run `/quota_status`. If a provider is missing, log in to it again in OpenCode 2 (`/connect`, or `opencode auth login <provider>`).

Your 4.x global settings convert on the first start, as in [Moving from 5.x](#moving-from-5x).

What changed in `5.0.0`:

- **OpenCode 1 is no longer supported.** On OpenCode 1, stay on 4.x: `"plugin": ["@slkiser/opencode-quota@4"]`.
- **Logins come only from OpenCode 2.** Inside OpenCode, logins come through OpenCode 2's plugin API; the terminal command reads `opencode.db` read-only. Neither reads `auth.json`.
- **Quota runs in OpenCode's background service.** Inside OpenCode, `PATH`, environment variables, and the working folder (your home folder) come from the service, not your terminal. See [Service environment](troubleshooting.md#service-environment).
- **Web and Desktop get slash commands, but no toasts or panels,** because OpenCode 2 gives plugins no Web UI hooks. See [Web and Desktop notes](manual-install.md#web-and-desktop-notes).
- **One plugin entry.** One `"plugin"` entry in `opencode.json` loads the server and the TUI; no `tui.json` entry is needed.
- **TUI reports open in the quota window** and leave no chat message.
- **OpenCode Zen uses your OpenCode Console sign-in; OpenCode Go uses it or an API key.** Their old workspace/cookie settings are no longer read. See [OpenCode Go](providers.md#opencode-go) and [OpenCode Zen](providers.md#opencode-zen).
