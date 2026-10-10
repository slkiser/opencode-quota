[← Back to README](../../README.md)

# Troubleshooting

## First checks

1. Run `/quota_status` inside OpenCode, or `opencode-quota status` in a terminal. Both show which config, providers, logins, and local files OpenCode Quota found.
2. Find the provider or feature that fails, and follow the matching fix below.
3. Restart OpenCode after changing config or logins.

Every provider missing? Check that `@slkiser/opencode-quota` is in the `plugin` list of `opencode.jsonc` or `.json`. That one entry also loads the TUI; no `tui.json` entry is needed.

## Logins

OpenCode Quota never reads `auth.json`. Inside OpenCode, it asks OpenCode 2 for logins (OpenCode keeps them in `opencode.db`). OpenCode 2 copies `auth.json` only once, the first time it starts. **If a provider is missing, log in to it again in OpenCode 2.**

In `/quota_status`, the `credential_source` section shows:

- `source`: where logins came from. From the terminal, this is `sqlite`.
- `list_error`: OpenCode could not list logins.
- `failures`: each login OpenCode could not return (for example a failed token refresh), as `provider:label:reason:detail`. That login also shows as an error row; log in to that provider again. From the terminal, `list_error` and `failures` stay empty.

`/quota_status` also shows the `opencode.db` path used for session and token history. `OPENCODE_DB` and `XDG_DATA_HOME` change it. Custom or source builds of OpenCode may use `opencode-<channel>.db`; set `OPENCODE_DB` to that file's path.

## Service environment

The TUI, Web, and Desktop get their numbers from OpenCode's background service. The service takes `PATH` and environment variables from whatever started it first, not from the terminal you use now, and it runs in your home folder. The terminal command uses your terminal's `PATH`, environment, and current folder instead.

- **`claude` or `bl` not found, or an API-key variable ignored:** in a terminal where they work, run `opencode service restart`. To keep that `PATH` for every later start, run `opencode service set env PATH "$PATH"` (it stops the service; open OpenCode again). For Claude you can instead set `anthropicBinaryPath`.
- A relative `export.path` is relative to your home folder.
- Cursor's plugin-entry check reads `opencode.json` in your global config folder and your home folder, not in the project folder.

## Terminal commands

`opencode-quota show` and `opencode-quota status` run in your terminal, not in OpenCode:

- They work with OpenCode closed and read logins from `opencode.db` read-only.
- They never refresh a token, so a sign-in can show as expired (for example `Token expired`) until you open OpenCode.
- They use your shell's `PATH` and API-key variables.
- They use the settings of the folder you run them in, so a project's `opencode-quota/quota-toast.jsonc` applies.

## Common problems

| Problem                                                     | Try this                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Slash commands are missing                                  | Check the plugin entry above, then restart OpenCode.                                                     |
| `/quota` shows no providers                                 | Run `/quota_status` and check provider detection and [logins](#logins).                                  |
| Sidebar is missing                                          | Set `tuiSidebarPanel.enabled` to `true`.                                                                 |
| Compact line is missing                                     | Set `tuiCompactStatus.enabled` to `true`.                                                                |
| Compact line appears on Home only                           | Set `tuiCompactStatus.sessionPrompt` to `true`.                                                          |
| TUI toast is missing                                        | Check `enableToast`, `showOnIdle`, `showOnQuestion`, and `showOnCompact`. Toasts appear only in the TUI. |
| Token reports are empty                                     | Start OpenCode once so it creates `opencode.db`, then use a model.                                       |
| Pricing looks old                                           | Run `/pricing_refresh`.                                                                                  |
| Web report columns do not line up                           | Expected: Web uses a proportional font. Use the TUI or `npx @slkiser/opencode-quota show`.               |
| Terminal shows a sign-in as expired but OpenCode shows data | The terminal never refreshes tokens. Open OpenCode (or use that provider in it) once, then retry.        |
| The updater reports findings or fails                       | See [Updating safely](updating.md#what-stays-manual). Never paste credential values into reports.        |

## Provider fixes

Run `/quota_status` first and check that provider's section. Setup steps and API-key variable names are in [Providers](providers.md).

<details>
<summary><strong>Custom providers</strong></summary>

`/quota_status` lists each definition under `quota_providers`: IDs, mode, format or exact local state path, model coverage, live outcome, credential type, environment variable name, and safe checked paths. These results are fetched live for the status command; cached results are not substituted.

| Symptom                                    | Fix |
| ------------------------------------------ | --- |
| Config is rejected                         | Run `opencode-quota provider add` and keep `quotaProviders` in global OpenCode JSONC/JSON. Remove `customSources`, unknown fields, duplicate IDs/request identities, or overlapping model coverage. |
| Definition is `unavailable`                | Confirm OpenCode reports the exact `providerId`. With `onlyCurrentModel`, the model id (without provider prefix) must match `modelIds`, or omit `modelIds`. |
| `missing_credential`                       | Set the `apiKeyEnv` variable, trusted global `provider.<providerId>.options.apiKey`, or an API-key login saved in OpenCode 2 for that provider id. |
| `http_error`, `timeout`, or response error | Check the endpoint and its response format. `/quota_status` intentionally hides URLs, request/response contents, raw errors, and secret material. |
| One definition fails but others show       | Expected. Working definitions stay visible; the failed one stays an error row. |
| Single-window output shows fewer rows      | Each source keeps only its lowest remaining percentage, or first value row. Use `"formatStyle": "allWindows"` for every row. |
| CLI/export looks stale                     | `show --json` and the export file are cache-only. Trigger a normal TUI refresh first. `/quota_status` is the live check. |

</details>

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

| Symptom                              | Fix |
| ------------------------------------ | --- |
| `claude` not found                   | Install Claude Code. OpenCode Quota tries `claude` on the [service `PATH`](#service-environment), then `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, and `/usr/local/bin/claude` (not on Windows). `binary_path` shows which one ran. |
| Claude is installed at a custom path | Set `anthropicBinaryPath` in `opencode-quota/quota-toast.json`. |
| Not signed in                        | Run `claude auth login`, then check `claude auth status`. |
| Signed in but no quota rows          | Check `quota_source` and `message`; sign in to Claude again if the OAuth credential fallback is missing or stale. |
| Provider not detected                | Make sure OpenCode uses the `anthropic` provider. |

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

Check `copilot_quota_auth`, `deployment`, `api_host`, `enterprise_host_source`, `billing_model`, `billing_scope`, `quota_api`, `budget_api`, and `token_compatibility_error`.

| Symptom                                           | Fix |
| ------------------------------------------------- | --- |
| Copilot works in OpenCode but no personal quota   | Check `oauth_accounting_state`, `deployment`, and `api_host`; log in to Copilot again if the token or its saved GHE.com host is invalid. |
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
| OpenAI quota missing                     | Run `opencode auth login openai`. |
| `ChatGPT quota unavailable for Sign in with ChatGPT` | OpenAI doesn't share ChatGPT usage with this login. Run `/connect` → OpenAI → **Codex browser (legacy)** or **Codex device code (legacy)**. |
| `OpenAI sign-in could not be refreshed`  | OpenCode could not refresh that login. Run the `opencode auth logout openai <label>` command the error names to remove it (`opencode auth list` shows the labels), then `opencode auth login openai`. Signing in again alone can leave a broken login with another label in place. For xAI (`xAI sign-in could not be refreshed`), run `opencode auth login xai`. |
| Provider not detected                    | Make sure OpenCode uses the `openai` provider or a compatible OpenAI login. |

</details>

<details>
<summary><strong>Cursor</strong></summary>

| Symptom                                   | Fix |
| ----------------------------------------- | --- |
| Cursor not detected                       | Put `cursor-opencode-provider/plugin/opencode2` before `@slkiser/opencode-quota` in `opencode.json`. |
| Cursor login missing                      | Run `/connect` → **Cursor** in OpenCode, or set `CURSOR_API_KEY`. |
| Quota shows but no remaining percentage   | Set `cursorPlan` or `cursorIncludedApiUsd`. |
| Billing cycle looks wrong                 | Set `cursorBillingCycleStartDay` to your billing day. |
| Unknown Cursor pricing                    | Run `/pricing_refresh`. If still unknown, check `/quota_status` for unknown model ids. Cursor `auto`, `composer*`, and `grok-4.5`–`grok-4.7` use bundled Cursor pricing. |

</details>

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Check the Alibaba login, tier, state-file path, and `alibaba_coding_plan` live check.

| Symptom              | Fix |
| -------------------- | --- |
| API key not detected | See [API keys](providers.md#api-keys). Repo-local provider secrets are ignored. |
| Limits need tuning   | Run `opencode-quota provider add`, choose local estimate, and use the `alibaba-coding-plan` id with its five-hour, weekly, and monthly rolling windows. |
| Counters do not move | Make sure the current model is `alibaba/*` or `alibaba-cn/*`. |
| Quota seems stale    | Check the state-file path shown in `/quota_status`. |

</details>

<details>
<summary><strong>Alibaba Personal Token Plan</strong></summary>

Check the `alibaba_token_plan` live check (separate from Alibaba Coding Plan).

| Symptom                 | Fix |
| ----------------------- | --- |
| CLI not detected        | Install `bailian-cli` so `bl` is in an absolute folder on the [service `PATH`](#service-environment), outside the project folder (for example `/opt/homebrew/bin`, `~/.local/bin`, or an nvm folder). On Windows, use WSL. See [setup](providers.md#alibaba-personal-token-plan). |
| Console session expired | Run `bl auth login --console`. A Coding Plan API key cannot sign in to this provider. |
| Weekly row only         | The official CLI may leave out the five-hour window. OpenCode Quota does not invent it. |
| JSON export empty       | `show --json` is cache-only, and this provider is not cached, so a separate CLI process reports it unavailable instead of running `bl`. |

</details>

<details>
<summary><strong>API-key providers (MiniMax, Kimi, Chutes AI, Synthetic, Z.ai, Zhipu, NanoGPT, DeepSeek, OpenRouter)</strong></summary>

- Check the provider's API-key section in `/quota_status` (for example `kimi:`, `kimi_cn:`, or `openrouter:`, which also shows the live check and errors such as HTTP 401).
- Put keys in environment variables or trusted user/global config, never in the project's `opencode.json`. Variable names and rules: [API keys](providers.md#api-keys).
- Kimi keys go only to their own region's host: see [Kimi Code](providers.md#kimi-code).
- Synthetic says `Synthetic returned no quota data for this account.`: the quota endpoint returned HTTP 200 `{}`. This is not a bad API key or a Clerk/browser problem, and no 5h or Weekly rows are invented. `/quota_status` shows it on `live_error_*`.

</details>

<details>
<summary><strong>Google AGY</strong></summary>

Check the `google_agy` section.

| Symptom                             | Fix |
| ----------------------------------- | --- |
| Companion missing                   | Put `@anthonyhaussman/opencode-agy-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Provider not enabled in manual mode | Include `google-agy` in `enabledProviders`. |
| Login missing                       | Run `opencode auth login google-agy`. |
| Project missing                     | Set `OPENCODE_AGY_PROJECT_ID` or `provider.google-agy.options.projectId`. |
| No rows                             | Check `live_probe`, `live_entry_*`, and `live_error_*`. |

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Google ended personal accounts on 2026-06-18, so personal Google users should use [Google AGY](providers.md#google-agy-quick-setup) instead.

| Symptom                             | Fix |
| ----------------------------------- | --- |
| Companion missing                   | Put `opencode-gemini-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Provider not enabled in manual mode | Include `google-gemini-cli` in `enabledProviders`. |
| Login missing                       | Run `opencode auth login google`. |
| Project missing                     | Set `provider.google.options.projectId`, `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_CLOUD_PROJECT_ID`. |

</details>

<details>
<summary><strong>Xiaomi MiMo</strong></summary>

Check the `xiaomi` section. It shows state, source, checked paths, and safe live summaries, never cookie names, cookie values, or raw responses.

| Symptom                             | Fix |
| ----------------------------------- | --- |
| Config not detected                 | Set `MIMO_USAGE_COOKIE` or create trusted user/global `opencode-quota/mimo.json`, then rerun `/quota_status`. |
| Config is invalid                   | Fix or remove the reported higher-priority source; an invalid source blocks fallback on purpose. |
| Provider not enabled in manual mode | Include `xiaomi` in `enabledProviders`. |
| Monthly quota missing               | Make sure the plan is active and check `live_error_*`; expired plans are hidden. |
| Balance or plan details missing     | Check the partial live summary. The requests fail independently, so other rows can still show. |
| Session expired                     | Sign in again at `platform.xiaomimimo.com`, copy a fresh Cookie header ([how](providers.md#xiaomi-mimo)), and update the same source. |

</details>

<details>
<summary><strong>OpenCode Go</strong></summary>

Check the `opencode_go` section:

- `auth_*`: key diagnostics (never the key itself). `selected_windows`: the windows shown. `live_fetch_error`: why the usage API failed.
- With a Console sign-in: `console_auth_state` and `console_server` describe it, `go_source` shows who answered (`console` or `legacy_key`), and `console_error` shows why the Console failed.
- `opencode_go_state: not_subscribed`: the Console reports no Go subscription (for example HTTP 404 from `/api/go/status`). An HTTP 403 is a failed Console request.

| Symptom                           | Fix |
| --------------------------------- | --- |
| Provider not detected             | Run `opencode auth login opencode`, or set an API key ([order](providers.md#opencode-go)). Then check `auth_state`, `auth_source`, and `auth_checked_paths`. |
| `auth_state` is `invalid`         | Run `opencode auth login opencode-go`. A broken `opencode-go` login blocks the legacy `opencode` fallback and shows in `auth_error`. |
| `OpenCode Console sign-in failed` | Shown only when no API key is set. Run `opencode auth login opencode`, or set an API key. `console_error` has the reason. |
| No Go quota, `console_error` set  | The Console request failed and no API key is set (`Not configured` in manual mode). Retry, or set an API key. |
| API returns 401 or 403            | The usage API rejected the key. Update the source shown by `auth_source`, wait briefly for the credential cache to expire, and rerun `/quota_status`. |
| Invalid API response              | Check `live_fetch_error`. 5h, Weekly, and Monthly must all be valid; one bad window rejects the whole response. |
| Request times out or fails        | Check `live_fetch_error`, make sure `https://opencode.ai/zen/go/v1/usage` is reachable, and retry. Raise `requestTimeoutMs` only for timeouts. |
| Expected window is not shown      | Check `selected_windows`, then update `opencodeGoWindows` (`rolling`, `weekly`, `monthly`). |
| Provider missing in manual mode   | Include `opencode-go` in `enabledProviders`. |

</details>

<details>
<summary><strong>OpenCode Zen</strong></summary>

Check the `opencode_zen` section. `console_auth_state` shows whether OpenCode returned your Console sign-in, `console_server` and `console_org` show which Console and organization Zen reads, and `budget_source` shows whether the budget came from the org budget (`org_budget`) or the credit limit plus this month's usage (`credit_limit`). `live_fetch_error` lists failed Console routes. The token is never shown.

| Symptom                                                           | Fix |
| ----------------------------------------------------------------- | --- |
| Zen does not appear                                               | Run `opencode auth login opencode` and sign in to the Console. An API key alone is not a Console sign-in. To see a hint instead of nothing, include `opencode` in `enabledProviders`. |
| `OpenCode Console sign-in failed` or `session expired or invalid` | Run `opencode auth login opencode` again. |
| Wrong organization                                                | Run `opencode auth switch opencode`, or sign in again and pick the organization. Check `console_org`. |
| `OpenCode Console <route> error 403`                              | Your sign-in cannot read that route for this organization. Zen still shows the other rows, unless the route is `billing/status` (the balance). |

</details>

<details>
<summary><strong>Token reports</strong></summary>

Check the pricing snapshot health and the `opencode.db` path.

| Symptom                                | Fix |
| -------------------------------------- | --- |
| `/tokens_*` is empty                   | Start OpenCode once so it creates `opencode.db`, then use a model. |
| Pricing looks stale                    | Run `/pricing_refresh`. |
| Runtime pricing does not change output | Check `pricingSnapshot.source`; `bundled` keeps the packaged pricing. |

</details>
