[← Back to README](../../README.md)

# Troubleshooting

## First checks

1. Run `/quota_status` inside OpenCode, or `opencode-quota status` in a terminal. Both show which settings, providers, logins, and local files OpenCode Quota found.
2. Find the provider or feature that fails, and follow the matching fix below.
3. Restart OpenCode after changing `opencode.json`. Changes to logins and `settings.jsonc` apply without a restart.

The report starts with `environment`: when it was made, where (`origin`: `/quota_status`, the `quota_status` tool, the TUI Plugin tab, or the terminal command), the OpenCode version and channel, the system, and the runtime. The `settings` section uses `settings.jsonc` keys:

- `providers.off`: switched-off provider ids, or `(none)` when every discovered provider is checked.
- `changed_from_defaults`: each setting that differs from its default, with its value. A list or names show as a count, and a color, separator or path you typed as `(custom color)`, `(custom separator)` or `(custom path)`.
- `current_model`: the session's provider and model, for example `openai/gpt-5`. A model the shipped price list does not have shows as `(model not in the shipped price list)`.

The `notices` section counts active, future and expired notices. Pricing settings appear as `providers.pricing.source` and `providers.pricing.autoRefreshDays`.

Every provider missing? Check that `@slkiser/opencode-quota` is in the `plugin` list of `opencode.jsonc` or `.json`. That one entry also loads the TUI; no `tui.json` entry is needed.

## Logins

OpenCode Quota never reads OpenCode's `auth.json`. Inside OpenCode, it asks OpenCode 2 for logins (OpenCode keeps them in `opencode.db`). OpenCode 2 copies `auth.json` only once, the first time it starts. **If a provider is missing, log in to it again in OpenCode 2.**

In `/quota_status`, the `credential_source` section shows:

- `source`: where logins came from. From the terminal, this is `sqlite`.
- `list_error`: OpenCode could not list logins: the error's kind and when.
- `failures`: each login OpenCode could not return (for example a failed token refresh), as `provider: reason at <time>`. That login also shows as an error row; log in to that provider again. From the terminal, `list_error` and `failures` stay empty.

`/quota_status` also shows the `opencode.db` path used for session and token history. `OPENCODE_DB` and `XDG_DATA_HOME` change it; a path they set shows as `(custom path)/opencode.db`. Custom or source builds of OpenCode may use `opencode-<channel>.db`; set `OPENCODE_DB` to that file's path.

## Service environment

The TUI, Web, and Desktop get their numbers from OpenCode's background service. The service takes `PATH` and environment variables from whatever started it first, not from the terminal you use now, and it runs in your home folder. The terminal command uses your terminal's `PATH`, environment, and current folder instead.

- **`claude` or `bl` not found, or an API-key variable ignored:** in a terminal where they work, run `opencode service restart`. To keep that `PATH` for every later start, run `opencode service set env PATH "$PATH"` (it stops the service; open OpenCode again). For Claude you can instead set `providers.anthropic.binaryPath`.
- Cursor's plugin-entry check reads the [OpenCode config files](#opencode-config-files) of the session's folder, not of the service's folder.

## OpenCode config files

OpenCode Quota reads OpenCode's own config files the way OpenCode does. For a session, these count, from lowest to highest rank:

1. `opencode.json`, then `opencode.jsonc`, in the global OpenCode folder (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`).
2. The file `OPENCODE_CONFIG` names.
3. `opencode.json`, then `opencode.jsonc`, in every folder from the top of the drive down to the session's folder.
4. The same two files in the `.opencode` folder of each of those folders, from the top down.

A file ranked higher wins. Both kinds may hold comments and trailing commas. With `OPENCODE_DISABLE_PROJECT_CONFIG` (or `OPENCODE_CONFIG_PROJECT_DISABLE`) set to `1` or `true`, only 1 and 2 count. The terminal command uses the folder it runs in as the session's folder.

`/quota_status` (the slash command and the `quota_status` tool; the TUI Plugin tab never writes) adds an empty `provider.<id>` entry for each provider it found available that none of these files declares. It writes only the global folder's `opencode.jsonc`, else its `opencode.json`, else a new `opencode.jsonc`, and in `opencode.jsonc` puts a `// Detected <id> authentication; …` comment above the entry. It edits the text in place, keeps comments, writes through a symlink, and writes nothing when the file changed while it ran. It never writes a project file.

## Terminal commands

`opencode-quota show` and `opencode-quota status` run in your terminal, not in OpenCode:

- They work with OpenCode closed and read logins from `opencode.db` read-only.
- They never refresh a token, so a sign-in can show as expired (for example `Sign in again`) until you open OpenCode.
- They use your shell's `PATH` and API-key variables.
- They read the same global `settings.jsonc` as OpenCode.
- `status --json` prints the report as data: `version` (`"6"`), `generatedAt`, `config`, `providers`, `pricing`, and `liveProbes`.

## Common problems

| Problem                                                     | Try this                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Slash commands are missing                                  | Check the plugin entry above, then restart OpenCode.                                                     |
| `/quota` shows no providers                                 | Run `/quota_status` and check provider detection and [logins](#logins).                                  |
| Sidebar is missing                                          | Open a session: the `Quota` panel is in its sidebar. A collapsed panel opens when you click its title.   |
| Status line is missing                                      | It uses only the free room in the footer under the message box. Widen the terminal.                      |
| TUI toast is missing                                        | Toasts show after compaction and when every provider fails. Toasts appear only in the TUI.               |
| `/quota_usage` is empty                                     | Start OpenCode once so it creates `opencode.db`, then use a model.                                       |
| Pricing looks old                                           | Press `p` in the TUI's Usage tab (`/quota_usage`).                                                       |
| Web report columns do not line up                           | Expected: Web uses a proportional font. Use the TUI or `npx @slkiser/opencode-quota show`.               |
| Terminal shows a sign-in as expired but OpenCode shows data | The terminal never refreshes tokens. Open OpenCode (or use that provider in it) once, then retry.        |

## Provider fixes

Run `/quota_status` first and check that provider's section. Every known provider has a section, named after its id (for example `copilot:` or `opencode-go:`). It shows `state` (`ok`, `partial`, `error`, `not checked`, `unavailable`, or `disabled`; an error adds its kind and HTTP status, for example `Provider error 503 (provider_error, http 503)`), `checked_at`, the `rows` it returned (id, window, numbers, reset time), and the provider's details from its own list of known keys. Each failed login's error shows as its kind and HTTP status (`error_kind: provider_error, http 503`), and a row the provider sent but OpenCode Quota could not use as its reason (`dropped_row: invalid window`). An `unavailable` provider is not asked for quota; its section shows whether OpenCode lists it (`opencode_provider`) and, for an API-key provider or Cursor, whether a key is set and where it was looked for (`api_key_configured`, `api_key_source`, `api_key_checked_paths`, or Cursor's `auth_state` and `auth_candidate_paths`). A `disabled` provider (listed in `providers.off`) is never asked. The report prints only words from OpenCode Quota's own lists (provider ids, row keys, states, setting keys, known env variables, known OpenCode folders and files), numbers and times. Everything else stands in as a placeholder or a count: logins as `account 1`, a part of a row id the provider named as `(part 1)`, a custom definition as `custom 1`, a path outside the known folders as `(custom path)`, an env variable that provider does not read as `env:(other)`, and any other detail as `3 other details not shown`. Provider messages, labels, names, URLs and custom ids never appear. Amounts show at most three significant digits (`1.23K`, `988T`); counts, days, percents and versions show only in their usual range, else `(out of range)`; times show only from 2000 to 2099, else `(invalid date)`. Read the report before you paste it into an issue. Setup steps and API-key variable names are in [Providers](providers.md).

<details>
<summary><strong>Custom providers</strong></summary>

`/quota_status` lists each definition in the `settings` section by its place in `providers.custom`, with its mode and model count, for example `providers.custom: custom 1 (remote-api, 3 models)`; it never shows a definition's id, URL, environment variable name or model ids. The `quota-providers` section shows the live check: `state`, the rows (a definition as `(custom 1)`), and a `custom 1 check` line per definition with its outcome, HTTP status, credential source, and checked paths (or local state health). These results are fetched live for the status command; cached results are not substituted.

| Symptom                                    | Fix |
| ------------------------------------------ | --- |
| Config is rejected                         | Keep definitions in `providers.custom` in `settings.jsonc` ([where](configuration.md#where-settings-live)). Remove unknown fields, duplicate IDs/request identities, or overlapping model coverage. |
| Definition is `unavailable`                | Confirm OpenCode reports the exact `providerId`. With `words.onlyCurrentModel`, the model id (without provider prefix) must match `modelIds`, or omit `modelIds`. |
| `Not set up` (`missing_credential`)       | Set the `apiKeyEnv` variable, `provider.<providerId>.options.apiKey` in an [OpenCode config file](#opencode-config-files), or an API-key login saved in OpenCode 2 for that provider id. |
| `Provider error <code>`, `Timed out`, `Can't reach …`, or `Unexpected reply` | Check the endpoint and its response format; the `custom 1 check` outcome says which step failed. `/quota_status` intentionally hides URLs, request/response contents, raw errors, and secret material. |
| One definition fails but others show       | Expected. Working definitions stay visible; the failed one stays an error row. |
| CLI/export looks stale                     | `show --json` is cache-only, and the export file changes only when the server's quota does. Open a TUI session first. `/quota_status` is the live check. |

</details>

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

| Symptom                              | Fix |
| ------------------------------------ | --- |
| `claude` not found                   | Install Claude Code. OpenCode Quota tries `claude` on the [service `PATH`](#service-environment), then `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, and `/usr/local/bin/claude` (not on Windows). `binary_path` shows which one ran. |
| Claude is installed at a custom path | Set `providers.anthropic.binaryPath` in `settings.jsonc`. |
| Not signed in                        | Run `claude auth login`, then check `claude auth status`. |
| Signed in but no quota rows          | Check `auth_status` and `quota_source`; sign in to Claude again if the OAuth credential fallback is missing or stale. |
| Provider not detected                | Make sure OpenCode uses the `anthropic` provider. |

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

Check the `copilot` section: `pat_state`, `pat_organization` and `pat_enterprise` (`set` or `not set`), `deployment`, `api_host` (`api.github.com` or `github enterprise (custom host)`), `enterprise_host_source`, `billing_model`, `billing_scope`, `billing_period`, `quota_api`, and `budget_api`.

| Symptom                                           | Fix |
| ------------------------------------------------- | --- |
| Copilot works in OpenCode but no personal quota   | Check `oauth_accounting_state` and `deployment`; log in to Copilot again if the token or its saved GHE.com host is invalid. |
| Organization or enterprise accounting is missing  | Create `copilot-quota-token.json` as in [GitHub Copilot setup](providers.md#github-copilot). |
| GHE.com host is rejected                          | Use the enterprise hostname (for example `acme.ghe.com`) or a host-only HTTPS URL. No `api.`, path, query, fragment, port, userinfo, wildcard, HTTP, IP/localhost, or other domain. |
| Personal report is forbidden                      | Use a fine-grained PAT with **Plan: read** or a GitHub App user token. An installation token cannot read a personal report. |
| Organization report or budget is forbidden        | Use an organization admin/billing-manager credential. Fine-grained PATs and GitHub App tokens need **Organization administration: read**. Usage can still show with a budget warning when only budget access fails. |
| Enterprise report is forbidden                    | Use a classic PAT held by an enterprise admin or billing manager. |
| Usage shows without a percentage                  | Expected when GitHub gives usage but no allowance or budget. OpenCode Quota never invents a percentage. |
| Legacy PRU config is rejected                     | Use `"billingModel": "legacy_premium_requests"` only for an annual Pro or Pro+ plan that stayed on legacy billing after June 1, 2026. |
| Rate-limit error                                  | Wait for GitHub's API rate limit to reset, then run `/quota` again. |

</details>

<details>
<summary><strong>OpenAI and xAI</strong></summary>

| Symptom                                  | Fix |
| ---------------------------------------- | --- |
| OpenAI quota missing                     | Sign in with a Codex login: `/connect` → OpenAI → **Codex browser (legacy)** or **Codex device code (legacy)**. **Sign in with ChatGPT** has no ChatGPT quota. |
| `ChatGPT quota unavailable for Sign in with ChatGPT` | OpenAI doesn't share ChatGPT usage with this login. Run `/connect` → OpenAI → **Codex browser (legacy)** or **Codex device code (legacy)**. |
| OpenAI or xAI shows `Sign in again`      | OpenCode could not refresh that login. Find it with `opencode auth list`, remove it with `opencode auth logout`, then run `opencode auth login openai` (or `xai`); signing in again alone can leave a broken login with another label in place. |
| Provider not detected                    | Make sure OpenCode uses the `openai` provider or a compatible OpenAI login. |

</details>

<details>
<summary><strong>Cursor</strong></summary>

| Symptom                                   | Fix |
| ----------------------------------------- | --- |
| Cursor not detected                       | Put `cursor-opencode-provider/plugin/opencode2` before `@slkiser/opencode-quota` in `opencode.json`. |
| Cursor login missing                      | Run `/connect` → **Cursor** in OpenCode, or set `CURSOR_API_KEY`. |
| Quota shows but no remaining percentage   | Set `providers.cursor.plan` or `providers.cursor.includedApiUsd`. |
| Billing cycle looks wrong                 | Set `providers.cursor.billingCycleStartDay` to your billing day. |
| Unknown Cursor pricing                    | Press `p` in the TUI's Usage tab (`/quota_usage`). If still unknown, check `unpriced_30d` in `/quota_status` (the share of the last 30 days' tokens without a price; it names a model only when the bundled price list has its id). Cursor `auto`, `composer*`, and `grok-4.5`–`grok-4.7` use bundled Cursor pricing. A prompt over 200k tokens on `claude-sonnet-4`, `gpt-5.4`, `gpt-5.5`, `gpt-5.6-*` or `grok-4.7*` has no price, nor do `gemini-3.6-flash`, `glm-5.3-flash`, `muse-*` and the `grok-4.7-500k` models. |

</details>

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Check the `alibaba-coding-plan` section: the login, tier (`alibaba_coding_plan`), and live check.

| Symptom              | Fix |
| -------------------- | --- |
| API key not detected | See [API keys](providers.md#api-keys). |
| Limits need tuning   | Add a local-estimate [custom provider](providers.md#custom-providers) with the `alibaba-coding-plan` id and its five-hour, weekly, and monthly rolling windows. |
| Counters do not move | Make sure the requests use OpenCode's `alibaba-coding-plan` or `alibaba` provider. |
| Quota seems stale    | Counters only count this machine's OpenCode requests; other machines and tools are not seen. |

</details>

<details>
<summary><strong>Alibaba Personal Token Plan</strong></summary>

Check the `alibaba-token-plan` section (separate from Alibaba Coding Plan).

| Symptom                 | Fix |
| ----------------------- | --- |
| CLI not detected        | Install `bailian-cli` so `bl` is in an absolute folder on the [service `PATH`](#service-environment), outside the project folder (for example `/opt/homebrew/bin`, `~/.local/bin`, an nvm folder, or `%LOCALAPPDATA%\Programs`). A native `bl` is run directly; npm's `bl.cmd` shim is resolved to the package's node entry and run with `node`. Other launchers (`.ps1`, `.bat`, a `bl` linking to `cmd.exe`) are refused. See [setup](providers.md#alibaba-personal-token-plan). |
| Console session expired | Run `bl auth login --console`. A Coding Plan API key cannot sign in to this provider. |
| The wrong plan, or no monthly row | The command carries no region or account: you see the plan `bl` is signed in to. `bl auth status` reports which account, region and site that is. |
| No monthly row          | `bl` reported no monthly percentage, so the plan may be unlimited — or the subscription has expired, which prints the same reply. Verify it in the Bailian Token Plan console. OpenCode Quota does not invent a row. `/quota_status` says the same under `window_hint`. |
| Old `bl`, nothing shown | `bailian-cli` 2.2.0 replaced the five-hour and weekly windows with one monthly window; older builds report only the removed ones, so the reply parses as no window. Upgrade with `npm install -g bailian-cli`. |
| JSON export empty       | `show --json` is cache-only, and this provider is not cached, so a separate CLI process reports it unavailable instead of running `bl`. |

</details>

<details>
<summary><strong>API-key providers (MiniMax, Kimi, Z.ai, Zhipu, DeepSeek, OpenRouter)</strong></summary>

- Check the provider's API-key section in `/quota_status` (for example `kimi-code-plan-global:`, `kimi-code-plan-cn:`, or `openrouter:`), which also shows the live check's result, for example `Sign in again (login_expired)` after HTTP 401.
- Put keys in environment variables or the global OpenCode config. A project's `opencode.json` counts too, as it does for OpenCode, but a key there can end up in the repository. Variable names and rules: [API keys](providers.md#api-keys).
- Kimi keys go only to their own region's host: see [Kimi Code](providers.md#kimi-code).

</details>

<details>
<summary><strong>Google AGY</strong></summary>

Check the `google-agy` section.

| Symptom                             | Fix |
| ----------------------------------- | --- |
| Companion missing                   | Put `@anthonyhaussman/opencode-agy-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Provider switched off | Remove `google-agy` from `providers.off`. |
| Login missing                       | Run `opencode auth login google-agy`. |
| Project missing                     | Set `OPENCODE_AGY_PROJECT_ID` or `provider.google-agy.options.projectId`. |
| No rows                             | Check `state` and `rows`. |

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Google ended personal accounts on 2026-06-18, so personal Google users should use [Google AGY](providers.md#google-agy-quick-setup) instead.

| Symptom                             | Fix |
| ----------------------------------- | --- |
| Companion missing                   | Put `opencode-gemini-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Provider switched off | Remove `google-gemini-cli` from `providers.off`. |
| Login missing                       | Run `opencode auth login google`. |
| Project missing                     | Set `provider.google.options.projectId`, `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_CLOUD_PROJECT_ID`. |

</details>

<details>
<summary><strong>Xiaomi MiMo</strong></summary>

Check the `xiaomi` section. It shows `config_state`, `config_source`, `config_checked_paths`, and the live check, never cookie names, cookie values, or raw responses.

| Symptom                             | Fix |
| ----------------------------------- | --- |
| Config not detected                 | Set `MIMO_USAGE_COOKIE` or create trusted user/global `opencode-quota/mimo.json`, then rerun `/quota_status`. |
| Config is invalid                   | Fix or remove the reported higher-priority source; an invalid source blocks fallback on purpose. |
| Provider switched off | Remove `xiaomi` from `providers.off`. |
| Monthly quota missing               | Make sure the plan is active and check `state`; expired plans are hidden. |
| Balance or plan details missing     | Check for `state: partial`. The requests fail independently, so other rows can still show. |
| Session expired                     | Sign in again at `platform.xiaomimimo.com`, copy a fresh Cookie header ([how](providers.md#xiaomi-mimo)), and update the same source. |

</details>

<details>
<summary><strong>OpenCode Go</strong></summary>

Check the `opencode-go` section:

- `auth_*`: key diagnostics (never the key itself). `selected_windows`: the windows shown. `live_fetch_error`: the usage API failed; `state` shows the error's kind.
- With a Console sign-in: `console_auth_state` describes it, `go_source` shows who answered (`console` or `legacy_key`), and `console_error` means the Console failed.
- `opencode_go_state: not_subscribed`: the Console reports no Go subscription (for example HTTP 404 from `/api/go/status`). An HTTP 403 is a failed Console request.

| Symptom                           | Fix |
| --------------------------------- | --- |
| Provider not detected             | Run `opencode auth login opencode`, or set an API key ([order](providers.md#opencode-go)). Then rerun `/quota_status`; once Go is detected, `auth_state`, `api_key_source`, and `api_key_checked_paths` show which key it uses. |
| `auth_state` is `invalid`         | Run `opencode auth login opencode-go`. A broken `opencode-go` login blocks the legacy `opencode` fallback. |
| Console sign-in failed or expired | `console_auth_state` is not `configured` (an expired one shows `Sign in again`); shown only when no API key is set. Run `opencode auth login opencode`, or set an API key. |
| No Go quota, `console_error` set  | The Console request failed and no API key is set (`Not configured` in manual mode). Retry, or set an API key. |
| API returns 401 or 403            | The usage API rejected the key. Update the source shown by `api_key_source`, wait briefly for the credential cache to expire, and rerun `/quota_status`. |
| Invalid API response              | `state` shows `Unexpected reply (bad_response)`. 5h, Weekly, and Monthly must all be valid; one bad window rejects the whole response. |
| Request times out or fails        | Check the error's kind in `state`, make sure `https://opencode.ai/zen/go/v1/usage` is reachable, and retry. Raise `providers.checking.requestTimeoutMs` only for timeouts. |
| Provider switched off | Remove `opencode-go` from `providers.off`. |

</details>

<details>
<summary><strong>OpenCode Zen</strong></summary>

Check the `opencode` section (OpenCode Zen). `console_auth_state` shows whether OpenCode returned your Console sign-in, and `budget_source` shows whether the budget came from your member budget (`member_budget`) or the credit limit plus this month's usage (`credit_limit`). `member_budget_note` appears when you have member budgets Zen can't evaluate, so it uses the credit limit. `live_fetch_error` means a Console route failed. The token, the Console's address, and the organization are never shown.

| Symptom                                                           | Fix |
| ----------------------------------------------------------------- | --- |
| Zen does not appear                                               | Run `opencode auth login opencode` and sign in to the Console. An API key alone is not a Console sign-in. Remove `opencode` from `providers.off` if it is switched off. |
| Zen shows `Sign in again`, or a failed `console_auth_state`       | Run `opencode auth login opencode` again. |
| Wrong organization                                                | Run `opencode auth switch opencode`, or sign in again and pick the organization. |
| Zen shows `Provider error 403`                                    | Your sign-in cannot read that route for this organization. Zen still shows the other rows, unless the route is `billing/status` (the balance). |

</details>

<details>
<summary><strong>Usage and pricing</strong></summary>

Check the pricing snapshot health and the `opencode.db` path.

| Symptom                                | Fix |
| -------------------------------------- | --- |
| `/quota_usage` is empty                | Start OpenCode once so it creates `opencode.db`, then use a model. |
| Pricing looks stale                    | Press `p` in the TUI's Usage tab (`/quota_usage`). |
| Runtime pricing does not change output | Check `providers.pricing.source`; `bundled` keeps the packaged pricing. |

</details>
