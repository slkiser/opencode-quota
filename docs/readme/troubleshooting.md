# Troubleshooting

[← Back to README](../../README.md)

Debug checklist, common symptoms, provider-specific fixes, and token report troubleshooting.

## Troubleshooting

Start here when quota or token data looks wrong.

1. Run `/quota_status`, or start with `opencode-quota show` for a terminal quota summary.
2. Confirm the expected provider appears in the detected provider list.
3. Confirm companion auth plugins are before `@slkiser/opencode-quota` in `opencode.json`.
4. If token reports are empty, start OpenCode once so it creates `opencode.db`, then run a session with model usage.
5. Use the provider-specific table below for the failing provider.

## Update OpenCode Quota safely

1. Close OpenCode.
2. Run:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

3. Review the exact config edits and cache directories, then confirm.
4. Restart OpenCode.

Use `--dry-run` to preview without changing anything. Use `--yes` only for explicit noninteractive confirmation. The update command changes only canonical OpenCode Quota plugin entries and removes only verified OpenCode Quota cache directories; it preserves settings, JSONC comments, tuple options, and other plugins.

### Common symptoms

| Symptom                                                          | Try this                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/quota` or other slash commands do not appear                   | For TUI slash/palette dialogs, confirm `tui.json` includes `@slkiser/opencode-quota`. For Web/Desktop output, confirm `opencode.json` includes it. Restart OpenCode after either change.                                                                                                                      |
| Command output appears in the wrong TUI location                 | Set `tuiCommandDisplay` to `"inline"` for the active session transcript (default) or `"dialog"` for the local popup, then restart OpenCode. Inline mode uses the dialog on Home because no transcript exists there.                                                                                           |
| `/quota` shows no providers                                      | Run `/quota_status`, then check provider detection and auth. You can also use `opencode-quota show` for a terminal quota summary.                                                                                                                                                                             |
| Sidebar panel does not appear                                    | Confirm `tui.json` includes `@slkiser/opencode-quota`, restart OpenCode, and check `tuiSidebarPanel.enabled`.                                                                                                                                                                                                 |
| Compact status line does not appear anywhere                     | Confirm `tui.json` includes `@slkiser/opencode-quota`, restart OpenCode, check `tuiCompactStatus.enabled`, and check whether `tuiCompactStatus.suppressWhenNativeProviderQuota` is hiding it because OpenCode exposes native provider-quota support.                                                          |
| Compact status appears on home but not in chat/session           | Check `tuiCompactStatus.sessionPrompt`; set it to `true` to show the chat/session prompt line.                                                                                                                                                                                                                |
| Popup toasts do not appear in the TUI                            | Check `enableToast`, `showOnIdle`, `showOnQuestion`, and `showOnCompact`. OpenCode 1.18.2 Web does not surface the TUI toast event; Safari/macOS notification permissions do not enable it.                                                                                                                   |
| Announcement home notice does not appear                         | Confirm `tui.json` includes `@slkiser/opencode-quota`, restart OpenCode, then check `maintainerAnnouncements.enabled`, `maintainerAnnouncements.home`, and the active count in the `maintainer_announcements` section of `/quota_status`.                                                                     |
| Token reports are empty                                          | Start OpenCode once so `opencode.db` exists, then run a session with model usage.                                                                                                                                                                                                                             |
| Pricing looks stale                                              | Run `/pricing_refresh`.                                                                                                                                                                                                                                                                                       |
| `/tokens_between` needs dates                                    | In TUI, choose the command and enter `YYYY-MM-DD YYYY-MM-DD` in its prompt dialog. In Web/Desktop, run `/tokens_between YYYY-MM-DD YYYY-MM-DD` inline.                                                                                                                                                        |
| Quota provider is missing or failing                             | Confirm the exact `providerId` exists at runtime and the definition is in global OpenCode `experimental.quotaToast.quotaProviders`. With manual selection, enable `quota-providers`. Then inspect `quota_providers` in `/quota_status`.                                                                       |
| Web shows `Failed to send command` after correct `/quota` output | In OpenCode 1.18.2 this is a false handled-command notification: the deterministic ignored/no-reply output already rendered and no model was called. Do not retry automatically after output appears. OpenCode has no clean server-command cancellation API, so this remains an accepted upstream limitation. |

### Provider troubleshooting

<details>
<summary><strong>Custom providers</strong></summary>

Run `/quota_status` and inspect `quota_providers`. Each definition shows its stable/provider IDs, mode, format or exact local state path, model coverage, live outcome, credential category, environment name, and safe checked paths. These results are fetched live for the status command; cached results are not substituted.

| Symptom                                    | Fix                                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config is rejected                         | Run `opencode-quota provider add` and keep `quotaProviders` in global OpenCode JSONC/JSON. Remove `customSources`, unknown fields, duplicate IDs/request identities, or overlapping model coverage.  |
| Definition is `unavailable`                | Confirm OpenCode reports the exact configured `providerId`. With `onlyCurrentModel`, confirm the model id without provider prefix matches `modelIds`, or omit `modelIds` for provider-wide coverage. |
| `missing_credential`                       | Set the explicit `apiKeyEnv`, or configure trusted global `provider.<providerId>.options.apiKey`, or a strict `{ "type": "api", "key": "..." }` auth entry.                                          |
| `http_error`, `timeout`, or response error | Check the endpoint service and response format. `/quota_status` intentionally hides URLs, request/response contents, raw errors, and secret material.                                                |
| One definition fails but others render     | This is expected partial-aggregate behavior. Successful definitions remain visible and the failed definition stays an error/status row.                                                              |
| Single-window output shows fewer rows      | Each source keeps only its lowest remaining percentage, or first value row. Use `"formatStyle": "allWindows"` for every row.                                                                         |
| CLI/export looks stale                     | `show --json` and the export file are cache-only and never fetch providers. Trigger a normal TUI/background refresh first. `/quota_status` is the live diagnostic surface.                           |

</details>

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

Run `/quota_status` and check the Anthropic section.

| Symptom                              | Fix                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `claude` not found                   | Install Claude Code and make sure `claude` is on your `PATH`.                                                                       |
| Claude is installed at a custom path | Set `anthropicBinaryPath` in `opencode-quota/quota-toast.json`.                                                                     |
| Not authenticated                    | Run `claude auth login`, then confirm `claude auth status` works.                                                                   |
| Auth works but no quota rows appear  | Check `quota_source` and `message` in `/quota_status`; re-authenticate Claude if the OAuth credential fallback is missing or stale. |
| Provider not detected                | Confirm OpenCode is configured to use the `anthropic` provider.                                                                     |

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

Run `/quota_status` and check `copilot_quota_auth`, `billing_model`, `billing_scope`, `quota_api`, `budget_api`, and `token_compatibility_error`.

| Symptom                                              | Fix                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode Copilot works but no accounting row appears | Create `copilot-quota-token.json` as described in [GitHub Copilot setup](providers.md#github-copilot). Normal Copilot OAuth does not carry the documented public billing permissions.                                     |
| Personal report is forbidden                         | Use a fine-grained PAT with **Plan: read** or a GitHub App user access token. A GitHub App installation token cannot query a personal report.                                                                             |
| Organization report or budget is forbidden           | Use an organization admin/billing-manager credential. Fine-grained PAT and GitHub App credentials need **Organization administration: read**. Usage can still appear with a budget warning when only budget access fails. |
| Enterprise report is forbidden                       | Use a classic PAT held by an enterprise admin or billing manager. GitHub does not support fine-grained PATs or GitHub App access tokens for enterprise billing reports.                                                   |
| Usage appears without a percentage                   | This is expected when GitHub supplies usage but no real allowance or positive budget denominator. opencode-quota does not invent a percentage.                                                                            |
| Legacy PRU config is rejected                        | Set `"billingModel": "legacy_premium_requests"` only for an existing annual Copilot Pro or Pro+ plan that remained on legacy billing after June 1, 2026.                                                                  |
| Rate-limit error                                     | Wait for GitHub's REST API rate limit to reset, then run `/quota` again.                                                                                                                                                  |

</details>

<details>
<summary><strong>OpenAI</strong></summary>

Run `/quota_status` and check the OpenAI auth source and token status.

| Symptom               | Fix                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------ |
| OpenAI quota missing  | Confirm OpenCode native OpenAI OAuth is present in `auth.json`.                            |
| Token expired         | Re-run OpenCode's OpenAI auth flow.                                                        |
| Provider not detected | Confirm your OpenCode config uses the `openai` provider or a compatible OpenAI auth entry. |

</details>

<details>
<summary><strong>Cursor</strong></summary>

Run `/quota_status` and check the Cursor section.

| Symptom                                   | Fix                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Cursor not detected                       | Put `@playwo/opencode-cursor-oauth` before `@slkiser/opencode-quota` in `opencode.json`.                |
| Cursor auth missing                       | Run `opencode auth login --provider cursor`.                                                            |
| Quota appears but no remaining percentage | Set `cursorPlan` or `cursorIncludedApiUsd` in `opencode-quota/quota-toast.json`.                        |
| Billing cycle looks wrong                 | Set `cursorBillingCycleStartDay` in `opencode-quota/quota-toast.json` to your local billing anchor day. |
| Unknown Cursor pricing                    | Run `/pricing_refresh`; if still unknown, check `/quota_status` for unknown model ids.                  |

</details>

<details>
<summary><strong>Qwen Code</strong></summary>

Run `/quota_status` and check `qwen_oauth_source`, `qwen_local_plan`, and the `qwen_code` live probe section.

| Symptom              | Fix                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Qwen not detected    | Put `opencode-qwencode-auth` before `@slkiser/opencode-quota` in `opencode.json`.                            |
| Auth missing         | Complete the Qwen companion plugin auth flow.                                                                |
| Counters do not move | Confirm the current model is `qwen-code/*`; Qwen quota is local request estimation for matching model usage. |
| Usage looks stale    | Check the local state file path shown by `/quota_status`.                                                    |

</details>

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Run `/quota_status` and check the Alibaba auth, resolved tier, state-file path, and `alibaba_coding_plan` live probe section.

| Symptom              | Fix                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API key not detected | Use `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_API_KEY`, trusted user/global OpenCode config, or OpenCode auth. Repo-local provider secrets are ignored.              |
| Limits need tuning   | Run `opencode-quota provider add`, choose local estimate, and use the maintained `alibaba-coding-plan` id with its five-hour, weekly, and monthly rolling windows. |
| Counters do not move | Confirm the current model is `alibaba/*` or `alibaba-cn/*`.                                                                                                        |
| Quota seems stale    | Check the state-file path shown in `/quota_status`.                                                                                                                |

</details>

<details>
<summary><strong>MiniMax, Kimi, Chutes AI, Synthetic, Z.ai, Zhipu, NanoGPT, and DeepSeek</strong></summary>

These providers use trusted env vars, trusted user/global OpenCode config, or native OpenCode auth. Run `/quota_status` and check the provider-specific API-key diagnostics.

| Provider                 | Useful checks                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MiniMax Coding Plan      | Use `MINIMAX_CODING_PLAN_API_KEY` or `MINIMAX_API_KEY` for the international endpoint. Runtime/config ids like `minimax` and `minimax-coding-plan` use this provider. Repo-local provider secrets are ignored.                        |
| MiniMax Coding Plan (CN) | Use `MINIMAX_CHINA_CODING_PLAN_API_KEY` or trusted user/global OpenCode config under `minimax-china-coding-plan`, `minimax-cn-coding-plan`, `minimax-cn`, or `minimax-china`. Runtime id `minimax-cn-coding-plan` uses this provider. |
| Kimi Code                | Use `KIMI_API_KEY` or `KIMI_CODE_API_KEY`; repo-local provider secrets are ignored.                                                                                                                                                   |
| Chutes AI                | Use `CHUTES_API_KEY`, trusted user/global config, or OpenCode auth.                                                                                                                                                                   |
| Synthetic                | Use `SYNTHETIC_API_KEY`, trusted user/global config, or OpenCode auth.                                                                                                                                                                |
| Z.ai Coding Plan         | Use `ZAI_API_KEY` or `ZAI_CODING_PLAN_API_KEY`; malformed fallback auth is surfaced as an auth error.                                                                                                                                 |
| Zhipu Coding Plan        | Use `ZHIPU_API_KEY` or `ZHIPU_CODING_PLAN_API_KEY`; malformed fallback auth is surfaced as an auth error.                                                                                                                             |
| NanoGPT                  | Use `NANOGPT_API_KEY`, `NANO_GPT_API_KEY`, trusted user/global config, or OpenCode auth.                                                                                                                                              |
| DeepSeek                 | Use `DEEPSEEK_API_KEY`, trusted user/global config under `provider.deepseek.options.apiKey`, or OpenCode auth. This provider shows balance only because DeepSeek does not expose a quota reset window.                                |

For security, repo-local `opencode.json` / `opencode.jsonc` is ignored for provider secrets in these integrations. Put secrets in environment variables or trusted user/global config. OpenCode auth fallbacks for API-key providers require `{ "type": "api", "key": "..." }` entries.

</details>

<details>
<summary><strong>Google Antigravity</strong></summary>

Run `/quota_status` and check the `google_antigravity` section.

| Symptom                  | Fix                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Companion missing        | Put `opencode-antigravity-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Accounts not found       | Check the selected `antigravity-accounts.json` path shown by `/quota_status`.        |
| Refresh tokens invalid   | Re-authenticate with the companion plugin.                                           |
| Provider returns no rows | Check `live_probe`, `live_entry_*`, and `live_error_*` in `/quota_status`.           |

</details>

<details>
<summary><strong>Google AGY</strong></summary>

Run `/quota_status` and check the `google_agy` section.

| Symptom                             | Fix                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Companion missing                   | Put `@anthonyhaussman/opencode-agy-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Provider not enabled in manual mode | Include `google-agy` in `enabledProviders` in `opencode-quota/quota-toast.json`.              |
| Auth missing                        | Run `opencode auth login --provider google-agy`.                                              |
| Project missing                     | Set `OPENCODE_AGY_PROJECT_ID` or `provider.google-agy.options.projectId`.                     |
| Provider returns no rows            | Check `live_probe`, `live_entry_*`, and `live_error_*` in `/quota_status`.                    |

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Run `/quota_status` and check the Gemini CLI live probe rows.

| Symptom                             | Fix                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Companion missing                   | Put `opencode-gemini-auth` before `@slkiser/opencode-quota` in `opencode.json`.                                              |
| Provider not enabled in manual mode | Include `google-gemini-cli` in `enabledProviders` in `opencode-quota/quota-toast.json`.                                      |
| Auth missing                        | Run `opencode auth login --provider google`.                                                                                 |
| Project missing                     | Set `provider.google.options.projectId`, `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_CLOUD_PROJECT_ID`. |

</details>

<details>
<summary><strong>OpenCode Go</strong></summary>

Run `/quota_status` and check the `opencode_go` section.

| Symptom                  | Fix                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config not detected      | Set both `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE`, then rerun `/quota_status`.                                                                                                 |
| Incomplete config        | `workspaceId` and `authCookie` must come from the same source.                                                                                                                                 |
| Scrape returns no data   | Refresh the browser `auth` cookie from `opencode.ai`.                                                                                                                                          |
| Selected window missing  | Check `/quota_status` for `selected_windows` and `live_fetch_error`; remove unavailable windows from `opencodeGoWindows` in `opencode-quota/quota-toast.json` or refresh the dashboard cookie. |
| Dashboard format changed | This integration scrapes the dashboard, so it can break if the dashboard markup changes.                                                                                                       |

</details>

<details>
<summary><strong>Token reports</strong></summary>

Run `/quota_status` and check pricing snapshot health plus OpenCode database paths.

| Symptom                                | Fix                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/tokens_*` is empty                   | Start OpenCode once so it creates `opencode.db`, then run a session with model usage.                         |
| Pricing looks stale                    | Run `/pricing_refresh`.                                                                                       |
| Runtime pricing does not change output | Check `pricingSnapshot.source` in `opencode-quota/quota-toast.json`; `bundled` keeps packaged pricing active. |
| Cursor model has unknown pricing       | Run `/pricing_refresh`; Cursor `auto` and `composer*` use bundled deterministic pricing.                      |

</details>
