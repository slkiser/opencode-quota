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

### Common symptoms

| Symptom                                                         | Try this                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/quota` or other slash commands do not appear                  | Confirm `opencode.json` includes `@slkiser/opencode-quota`, then restart OpenCode. The server plugin registers each command once for both TUI and Desktop/server; `tui.json` only enables the visual TUI surfaces.                                                                                                                      |
| Installer completed but old plugin behavior remains             | Restart OpenCode to load the pinned plugin version. Deleting OpenCode caches is unnecessary.                                                                                                                                                                                                                                            |
| `/quota` shows no providers                                     | Run `/quota_status`, then check provider detection and auth. You can also use `opencode-quota show` for a terminal quota summary.                                                                                                                                                                                                       |
| Sidebar panel does not appear                                   | Confirm `tui.json` includes `@slkiser/opencode-quota`, restart OpenCode, and check `tuiSidebarPanel.enabled`.                                                                                                                                                                                                                           |
| Compact status line does not appear anywhere                    | Confirm `tui.json` includes `@slkiser/opencode-quota`, restart OpenCode, check `tuiCompactStatus.enabled`, and check whether `tuiCompactStatus.suppressWhenNativeProviderQuota` is hiding it because OpenCode exposes native provider-quota support.                                                                                    |
| Compact status appears on home but not in chat/session          | Check `tuiCompactStatus.sessionPrompt`; set it to `true` to show the chat/session prompt line.                                                                                                                                                                                                                                          |
| Popup toasts do not appear                                      | Check `enableToast`, `showOnIdle`, `showOnQuestion`, and `showOnCompact`.                                                                                                                                                                                                                                                               |
| Announcement home notice does not appear                        | Confirm `tui.json` includes `@slkiser/opencode-quota`, restart OpenCode, then check `maintainerAnnouncements.enabled`, `maintainerAnnouncements.home`, and the active count in the `maintainer_announcements` section of `/quota_status`.                                                                                               |
| Token reports are empty                                         | Start OpenCode once so `opencode.db` exists, then run a session with model usage.                                                                                                                                                                                                                                                       |
| Pricing looks stale                                             | Run `/pricing_refresh`.                                                                                                                                                                                                                                                                                                                 |
| `/tokens_between` needs dates                                   | Run `/tokens_between YYYY-MM-DD YYYY-MM-DD`. Missing or invalid dates produce inline usage output; no date dialog opens.                                                                                                                                                                                                                |
| Desktop shows HTTP 500/error toast after correct command output | OpenCode 1.17.18 has no successful command-cancellation contract. The deterministic output was already injected as one ignored/no-reply message, and the handled sentinel prevents model continuation and context pollution. This is the accepted upstream limitation tracked by anomalyco/opencode#18554 and anomalyco/opencode#18559. |

### Provider troubleshooting

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

Run `/quota_status` and check `copilot_quota_auth`, `billing_mode`, `billing_scope`, and `quota_api`.

| Symptom                              | Fix                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal quota missing               | Confirm OpenCode Copilot auth works. The plugin can read OpenCode's Copilot OAuth token.                                                    |
| Business or Enterprise quota missing | Add `copilot-quota-token.json` in the OpenCode runtime config directory shown by `opencode debug paths`.                                    |
| PAT config exists but quota fails    | Fix `copilot-quota-token.json`; when present, it takes precedence over OAuth and does not silently fall back.                               |
| Enterprise usage missing             | Use a classic PAT with the required billing access. Fine-grained PATs and GitHub App tokens are not supported for Enterprise premium usage. |

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

| Symptom              | Fix                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key not detected | Use `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_API_KEY`, trusted user/global OpenCode config, or OpenCode auth. Repo-local provider secrets are ignored. |
| Wrong tier           | Set `alibabaCodingPlanTier` to `lite` or `pro` in `opencode-quota/quota-toast.json`.                                                                  |
| Counters do not move | Confirm the current model is `alibaba/*` or `alibaba-cn/*`.                                                                                           |
| Quota seems stale    | Check the state-file path shown in `/quota_status`.                                                                                                   |

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
