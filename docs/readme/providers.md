# Providers

[← Back to README](../../README.md)

Supported providers and provider-specific setup notes.

## Providers

Most providers work automatically. If a provider has a “Needs setup” link, open that setup note only if you use that provider.

| Provider | Auth/setup | Source | Reports |
| --- | --- | --- | --- |
| Anthropic (Claude) | [Needs setup](#anthropic-claude) | Local CLI/OAuth | Usage/quota |
| GitHub Copilot | OpenCode OAuth or PAT | Remote API | Quota/usage |
| OpenAI | Automatic | Remote API | Usage/quota |
| Cursor | [Needs setup](#cursor) | Local estimate | Estimated quota |
| Qwen Code | [Needs setup](#qwen-code) | Local estimate | Estimated quota |
| Alibaba Coding Plan | OpenCode config | Local estimate | Estimated quota |
| MiniMax Coding Plan | OpenCode config | Remote API | Usage/quota |
| MiniMax Coding Plan (CN) | OpenCode config | Remote API | Usage/quota |
| Kimi Code | OpenCode config | Remote API | Usage/quota |
| Chutes AI | API key/config | Remote API | Usage/quota |
| Synthetic | Automatic | Remote API | Quota |
| Google Antigravity | [Needs setup](#google-antigravity) | Remote API | Usage/quota |
| Google AGY | [Needs setup](#google-agy-quick-setup) | Remote API | Usage/quota |
| Gemini CLI | [Needs setup](#gemini-cli) | Remote API | Usage/quota |
| Z.ai Coding Plan | OpenCode config | Remote API | Usage/quota |
| Zhipu Coding Plan | OpenCode config | Remote API | Usage/quota |
| NanoGPT | API key/config | Remote API | Usage + balance |
| DeepSeek | API key/config | Remote API | Balance/status |
| Ollama Cloud | [Needs setup](#ollama-cloud) | Dashboard scraping | Dashboard usage |
| OpenCode Go | [Needs setup](#opencode-go) | Dashboard scraping | Dashboard usage |
| OpenCode Zen | [Needs setup](#opencode-zen) | Dashboard scraping | Balance/usage |

## Provider setup notes

<a id="anthropic-claude"></a>
### Anthropic (Claude)

Install Claude Code, authenticate it, and make sure `claude` is on your `PATH`:

```bash
claude auth login
claude auth status
```

If Claude lives at a custom path, set `anthropicBinaryPath` in `opencode-quota/quota-toast.json`.


<a id="cursor"></a>
### Cursor

Use companion plugin [`@playwo/opencode-cursor-oauth`](https://github.com/PoolPirate/opencode-cursor#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate once:

```bash
opencode auth login --provider cursor
```


<a id="qwen-code"></a>
### Qwen Code

Use companion plugin [`opencode-qwencode-auth`](https://github.com/gustavodiasdev/opencode-qwencode-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`.


<a id="google-antigravity"></a>
### Google Antigravity

Use companion plugin [`opencode-antigravity-auth`](https://github.com/NoeFabris/opencode-antigravity-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`.


<a id="google-agy-quick-setup"></a>
### Google AGY

Use companion plugin [`@anthonyhaussman/opencode-agy-auth`](https://www.npmjs.com/package/@anthonyhaussman/opencode-agy-auth). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate Google once:

```bash
opencode auth login --provider google-agy
```

If you use manual provider selection, include `google-agy` in `enabledProviders`.

```jsonc
{
  "enabledProviders": ["google-agy"],
}
```

If the AGY auth entry does not include a project id, set `OPENCODE_AGY_PROJECT_ID` or `provider.google-agy.options.projectId`.

```jsonc
{
  "provider": {
    "google-agy": {
      "options": {
        "projectId": "your-google-cloud-project"
      }
    }
  }
}
```


<a id="gemini-cli"></a>
### Gemini CLI

Use companion plugin [`opencode-gemini-auth`](https://github.com/jenslys/opencode-gemini-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate Google once:

```bash
opencode auth login --provider google
```

If you use manual provider selection, include `google-gemini-cli` in `enabledProviders`.


<a id="deepseek"></a>
### DeepSeek

DeepSeek shows the current on-demand account balance from `GET https://api.deepseek.com/user/balance`.

Use one of these trusted API-key sources:

```bash
export DEEPSEEK_API_KEY="your-api-key"
```

Or put the key in trusted user/global OpenCode config, not repo-local config:

```jsonc
{
  "provider": {
    "deepseek": {
      "options": { "apiKey": "{env:DEEPSEEK_API_KEY}" },
    },
  },
}
```

If you use manual provider selection, include `deepseek` in `enabledProviders`.


<a id="ollama-cloud"></a>
### Ollama Cloud

Ollama Cloud quota scrapes the Ollama Cloud settings page and needs a `__Secure-session` cookie:

```bash
export OLLAMA_USAGE_COOKIE="your-session-cookie-value"
```

Or use one of these config files (cookie without the `__Secure-session=` prefix, or with — the plugin normalizes it):

- `~/.config/opencode/opencode-quota/ollama-cloud.json`: `{ "cookie": "..." }`
- `~/.config/ollama-usage/config.yaml`: `cookie: "..."`

To find the cookie, open `ollama.com/settings` in your browser, open Developer Tools → Storage → Cookies, and copy the value of `__Secure-session`.


<a id="opencode-go"></a>
### OpenCode Go

OpenCode Go quota scrapes the dashboard and needs a workspace ID plus an `auth` cookie:

```bash
export OPENCODE_GO_WORKSPACE_ID="your-workspace-id"
export OPENCODE_GO_AUTH_COOKIE="your-auth-cookie"
```

Use `opencodeGoWindows` to choose **5h**, **Weekly**, and/or **Monthly** windows. Environment variables take precedence over the optional `opencode-go.json` file.

<a id="opencode-zen"></a>
### OpenCode Zen

OpenCode Zen balance scrapes the billing page at `opencode.ai/workspace/{id}/billing`. Set these environment variables:

```bash
export OPENCODE_WORKSPACE_ID="your-workspace-id"
export OPENCODE_AUTH_COOKIE="your-auth-cookie"
```

For backward compatibility with OpenCode Go credentials, `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` are also accepted.

**To get the `auth` cookie and workspace ID:** Same as OpenCode Go — DevTools → Cookies → copy `auth` from `opencode.ai`. The workspace ID is in the URL: `opencode.ai/workspace/<WORKSPACE_ID>/...`.

You can also create a config file at `{configDir}/opencode-quota/opencode.json`:

```jsonc
{
  "workspaceId": "your-workspace-id",
  "authCookie": "your-auth-cookie"
}
```

**Monthly budget override:** Set `opencodeMonthlyLimit` in `opencode-quota/quota-toast.json` to override the monthly limit from the billing page:

```jsonc
{
  "opencodeMonthlyLimit": 200
}
```

When no monthly limit is set on the billing page or via config, only the current balance is shown.

