[← Back to README](../../README.md)

# Troubleshooting

## First checks

1. Run `/quota_status` inside OpenCode, or `opencode-quota status` in a terminal. Both show which settings, providers, logins, and local files OpenCode Quota found.
2. Find the provider or feature that fails, and follow the matching fix below.
3. Restart OpenCode after changing `opencode.json`. Changes to logins and `settings.jsonc` apply without a restart.

Every provider missing? Check that `@slkiser/opencode-quota` is in the `plugin` list of `opencode.jsonc` or `.json`. That one entry also loads the TUI; no `tui.json` entry is needed.

## Logins

OpenCode Quota never reads OpenCode's `auth.json`. Inside OpenCode, it asks OpenCode 2 for logins (OpenCode keeps them in `opencode.db`). OpenCode 2 copies `auth.json` only once, the first time it starts. **If a provider is missing, log in to it again in OpenCode 2.** A login OpenCode could not return (for example after a failed token refresh) shows as an error row and under `credential_source` → `failures`; log in to that provider again.

`/quota_status` also shows the `opencode.db` path used for session and token history. `OPENCODE_DB` and `XDG_DATA_HOME` change it. Custom or source builds of OpenCode may use `opencode-<channel>.db`; set `OPENCODE_DB` to that file's path.

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

`/quota_status` (the slash command and the `quota_status` tool; the Plugin tab never writes) adds an empty `provider.<id>` entry for each available provider that none of these files declares, under a `// Detected <id> authentication; …` comment in `opencode.jsonc`. It writes only the global folder's `opencode.jsonc`, else its `opencode.json`, else a new `opencode.jsonc`. It keeps comments, writes through a symlink, writes nothing when the file changed while it ran, and never writes a project file.

## Terminal commands

`opencode-quota show` and `opencode-quota status` run in your terminal, not in OpenCode:

- They work with OpenCode closed, read logins from `opencode.db` read-only, and read the same global `settings.jsonc` as OpenCode.
- They never refresh a token, so a sign-in can show as expired (for example `Sign in again`) until you open OpenCode.
- They use your shell's `PATH` and API-key variables.

`status --json` prints the report as data: `version` (`"6"`), `generatedAt`, `config`, `providers`, `pricing`, and `liveProbes`.

## Common problems

| Problem                                                     | Try this                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Slash commands are missing                                  | Check the plugin entry above, then restart OpenCode.                                                     |
| `/quota` shows no providers                                 | Run `/quota_status` and check provider detection and [logins](#logins).                                  |
| Sidebar is missing                                          | Open a session: the `Quota` panel is in its sidebar. A collapsed panel opens when you click its title.   |
| `/quota_usage` is empty                                     | Start OpenCode once so it creates `opencode.db`, then use a model.                                       |
| Pricing looks old                                           | Press `p` in the TUI's Usage tab (`/quota_usage`).                                                       |
| Terminal shows a sign-in as expired but OpenCode shows data | The terminal never refreshes tokens. Open OpenCode (or use that provider in it) once, then retry.        |

## Provider fixes

Run `/quota_status` first. Every known provider has a section named after its id (for example `copilot:` or `opencode-go:`) with its `state` (`ok`, `partial`, `error`, `not checked`, `unavailable`, or `disabled`), `checked_at`, its `rows`, and its own details. An `unavailable` provider is not asked for quota; its section shows whether OpenCode lists it and, for an API-key provider or Cursor, where a key was looked for. The report prints only OpenCode Quota's own words (provider ids, row keys, states, setting keys), numbers and times: logins show as `account 1`, custom definitions as `custom 1`, other paths as `(custom path)`, and provider messages, labels, names, URLs and custom ids never appear. Read the report before you paste it into an issue. Setup steps are in [Providers](providers.md).

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

| Symptom                              | Fix |
| ------------------------------------ | --- |
| `claude` not found                   | Install Claude Code where the [service `PATH`](#service-environment) finds it, or set `providers.anthropic.binaryPath` in `settings.jsonc`. `binary_path` shows which one ran. |
| Not signed in                        | Run `claude auth login`, then check `claude auth status`. |

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

| Symptom                                           | Fix |
| ------------------------------------------------- | --- |
| Organization or enterprise accounting is missing  | Create `copilot-quota-token.json` as in [GitHub Copilot setup](providers.md#github-copilot). |
| GHE.com host is rejected                          | Use the enterprise hostname (for example `acme.ghe.com`) or a host-only HTTPS URL. No `api.`, path, query, fragment, port, userinfo, wildcard, HTTP, IP/localhost, or other domain. |
| Personal report is forbidden                      | Use a fine-grained PAT with **Plan: read** or a GitHub App user token. An installation token cannot read a personal report. |
| Organization report or budget is forbidden        | Use an organization admin/billing-manager credential. Fine-grained PATs and GitHub App tokens need **Organization administration: read**. Usage can still show with a budget warning when only budget access fails. |
| Enterprise report is forbidden                    | Use a classic PAT held by an enterprise admin or billing manager. |

</details>

<details>
<summary><strong>OpenAI and xAI</strong></summary>

| Symptom                                  | Fix |
| ---------------------------------------- | --- |
| `ChatGPT quota unavailable for Sign in with ChatGPT` | Run `/connect` → OpenAI → **Codex browser (legacy)** or **Codex device code (legacy)**. |
| OpenAI or xAI shows `Sign in again`      | OpenCode could not refresh that login. Find it with `opencode auth list`, remove it with `opencode auth logout`, then run `opencode auth login openai` (or `xai`); signing in again alone can leave a broken login with another label in place. |

</details>

<details>
<summary><strong>Cursor</strong></summary>

| Symptom                                   | Fix |
| ----------------------------------------- | --- |
| Cursor not detected                       | Put `cursor-opencode-provider/plugin/opencode2` before `@slkiser/opencode-quota` in `opencode.json`. |
| Unknown Cursor pricing                    | Press `p` in the TUI's Usage tab (`/quota_usage`). If still unknown, `unpriced_30d` in `/quota_status` shows the share of the last 30 days' tokens without a price; [Cursor](providers.md#cursor) lists the requests that have none. |

</details>

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

| Symptom                 | Fix |
| ----------------------- | --- |
| CLI not detected        | Install `bailian-cli` so `bl` is in an absolute folder on the [service `PATH`](#service-environment), outside the project folder. A native `bl` runs directly and npm's `bl.cmd` shim is run with the `node` on that `PATH`. See [setup](providers.md#alibaba-coding-plan). |
| Console session missing | The Coding Plan is read through the console session: run `bl auth login --console`. An API Key (AK/SK) signs in too: `bl auth login --open-api --access-key-id <id> --access-key-secret <secret>`. |
| No rows and no error    | The account has no Coding Plan subscription: the CLI prints `{}`, and OpenCode Quota then shows no rows, which is not a failure. |
| One window is missing   | The console reported no quota for that window: the plan does not cover it, or its limit is 0, so it has no row. Check it in the Bailian Coding Plan console. |
| Provider not detected   | Make sure the requests use OpenCode's `alibaba-coding-plan`, `alibaba-coding-plan-cn`, `alibaba`, or `alibaba-cn` provider. |

</details>

<details>
<summary><strong>Alibaba Token Plan</strong></summary>

| Symptom                 | Fix |
| ----------------------- | --- |
| CLI not detected        | Install `bailian-cli` so `bl` is in an absolute folder on the [service `PATH`](#service-environment), outside the project folder. A native `bl` runs directly and npm's `bl.cmd` shim is run with the `node` on that `PATH`. See [setup](providers.md#alibaba-token-plan). |
| Console session expired | The personal rows need the console session: run `bl auth login --console`. An API Key (AK/SK) saved with `bl auth login --open-api` renews an expired console token by itself, so the personal rows come back without a new login; the environment variables alone do not renew it. |
| Team seats show no rows | Team seats need API Key (AK/SK) credentials: run `bl auth login --open-api`, or set `ALIBABA_CLOUD_ACCESS_KEY_ID` and `ALIBABA_CLOUD_ACCESS_KEY_SECRET`. A released seat has no row by design. |
| The wrong plan          | The command carries no region or account: you see the plan `bl` is signed in to. `bl auth status` reports which account, region and site that is. |
| No quota data          | `bl` reported no usage ratio, so the plan may be unlimited — or the subscription has expired, which prints the same reply. A window without a ratio has no row. Check it in the Bailian Token Plan console. |
| Old `bl`, one window    | `bailian-cli` 2.7.1 reads every window the API reports; older builds report the monthly one only, so you see fewer rows. Upgrade with `npm install -g bailian-cli`. |
| JSON export empty       | `show --json` is cache-only, so the export fills after a live check instead of running `bl`. |

</details>

<details>
<summary><strong>API-key providers (MiniMax, Kimi, Z.ai, Zhipu, DeepSeek, OpenRouter)</strong></summary>

- Check the provider's section in `/quota_status` (for example `kimi-code-plan-global:` or `openrouter:`), which also shows the live check's result, for example `Sign in again (login_expired)` after HTTP 401.
- Put keys in environment variables or the global OpenCode config. A project's `opencode.json` counts too, as it does for OpenCode, but a key there can end up in the repository. Variable names and rules: [API keys](providers.md#api-keys).

</details>

<details>
<summary><strong>Google AGY and Gemini CLI</strong></summary>

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Personal Google users should use [Google AGY](providers.md#google-agy-quick-setup) instead.

| Symptom           | Google AGY                                                                | Gemini CLI |
| ----------------- | ------------------------------------------------------------------------- | --- |
| Companion missing | Put `@anthonyhaussman/opencode-agy-auth` before `@slkiser/opencode-quota` in `opencode.json`. | Put `opencode-gemini-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Login missing     | Run `opencode auth login google-agy`.                                     | Run `opencode auth login google`. |
| Project missing   | Set `OPENCODE_AGY_PROJECT_ID` or `provider.google-agy.options.projectId`. | Set `provider.google.options.projectId`, `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_CLOUD_PROJECT_ID`. |

</details>

<details>
<summary><strong>Xiaomi MiMo</strong></summary>

| Symptom                             | Fix |
| ----------------------------------- | --- |
| Config is invalid                   | Fix or remove the reported higher-priority source; an invalid source blocks fallback on purpose. |
| Session expired                     | Sign in again at `platform.xiaomimimo.com`, copy a fresh Cookie header ([how](providers.md#xiaomi-mimo)), and update the same source. |

</details>

<details>
<summary><strong>OpenCode Go</strong></summary>

| Symptom                           | Fix |
| --------------------------------- | --- |
| `auth_state` is `invalid`         | Run `opencode auth login opencode-go`. A broken `opencode-go` login blocks the legacy `opencode` fallback. |
| API returns 401 or 403            | The usage API rejected the key. Update the source shown by `api_key_source`, wait briefly for the credential cache to expire, and rerun `/quota_status`. |

</details>

<details>
<summary><strong>OpenCode Zen</strong></summary>

| Symptom                                                           | Fix |
| ----------------------------------------------------------------- | --- |
| Zen does not appear                                               | Run `opencode auth login opencode` and sign in to the Console. An API key alone is not a Console sign-in. |
| Wrong organization                                                | Run `opencode auth switch opencode`, or sign in again and pick the organization. |
| Zen shows `Provider error 403`                                    | Your sign-in cannot read that route for this organization. Zen still shows the other rows, unless the route is `billing/status` (the balance). |

</details>
