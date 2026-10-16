# cursor-opencode-provider

Use [Cursor](https://cursor.com) subscription models from [OpenCode](https://opencode.ai) and compatible coding agents by speaking Cursor's Connect-RPC agent protocol.

This project is a custom **AI SDK provider** (`LanguageModelV3`) plus an **OpenCode plugin** that handles authentication and model discovery. Instead of calling a generic chat-completions API, it encodes and decodes Cursor's protobuf agent protocol over HTTP/2 to Cursor's agent backend.

> **Runs unchanged across OpenCode, OpenCode 2.0, and five additional coding agents.** OpenCode loads this plugin natively, including through the dedicated OpenCode 2.0 entrypoint. [OCP — OpenCode Plugin Compatibility](https://github.com/oakimov/opencode-plugin-compat) runs the same published plugin, without a provider fork, in **Kilo Code, MiMo Code, pi, oh-my-pi, and DeepSeek Harness**. See [Coding-agent compatibility](#coding-agent-compatibility).
>
> **Status:** Usable end-to-end for authentication, model discovery, streaming, and tools. See [Known limitations](#known-limitations).

## Coding-agent compatibility

This package remains one OpenCode plugin and AI SDK provider. The external
**[OCP compatibility layer](https://github.com/oakimov/opencode-plugin-compat)**
adapts other hosts around that unchanged package: it translates their plugin
surfaces, model catalogs, tool vocabulary, authentication, and streaming events
instead of requiring a host-specific Cursor provider.

| Coding agent | How this package runs |
|---|---|
| **OpenCode** | Native plugin and AI SDK provider — [OpenCode 1.x setup](docs/opencode-1.md) |
| **OpenCode 2.0** | Native `cursor-opencode-provider/plugin/opencode2` — [OpenCode 2.0 setup](docs/opencode-2.md) |
| **Kilo Code** | Unchanged through OCP's OpenCode-clone compatibility layer |
| **MiMo Code** | Unchanged through OCP's OpenCode-clone compatibility layer |
| **pi** | Unchanged through `@opencode-compat/pi-bridge` and pi's provider extension API |
| **oh-my-pi (omp)** | Unchanged through the same Pi-family bridge |
| **DeepSeek Harness (dsh)** | Unchanged through `@opencode-compat/dsh-bridge` and DSH's Cordis `LlmAdapter` API |

Start with OCP's host guides:

- [OpenCode clones: Kilo Code and MiMo Code](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/hosts/opencode-clones.md)
- [Pi family: pi and oh-my-pi](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/hosts/pi-family.md)
- [DSH family: DeepSeek Harness](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/hosts/dsh-family.md)

OCP is designed to grow by adding host profiles and narrow adapters or bridges,
so support for other coding agents can be added there while this provider and
its package remain unchanged.

## Demo

OpenCode driving a Cursor-routed Grok model through this provider:

![OpenCode running a Grok model via cursor-opencode-provider](https://raw.githubusercontent.com/oakimov/cursor-opencode-provider/main/assets/opencode-grok.png)

## Features

- **Multi-host compatibility** — the same plugin package runs natively in OpenCode and OpenCode 2.0, and unchanged through OCP in Kilo Code, MiMo Code, pi, oh-my-pi, and DeepSeek Harness; new host support belongs in the compatibility layer rather than a provider fork
- **OpenCode integration** — registers a `cursor` provider with auth hooks and cached model list
- **Authentication** — browser OAuth (PKCE), or API key from [cursor.com/settings](https://cursor.com/settings)
- **Model discovery** — fetches available models from Cursor's API and caches them locally
- **Image input** — advertises vision only for supported models and forwards OpenCode image attachments to Cursor
- **Streaming** — bidirectional Connect-RPC Runs with stale-session rotation, health checks, semantic/read-idle deadlines, bounded replay-safe recovery, and activity-aware held tool continuations
- **Tool calls** — maps Cursor exec-server messages to AI SDK / OpenCode tool-call parts using only the advertised canonical catalog. Exact advertised subagent names win; standard Cursor roles select compatible OpenCode agents, and native Task maps to OpenCode 1.x `task` or OpenCode 2.0 `subagent`. OCP translates any alternate host vocabulary before it reaches this package. The bridge also covers Cursor's typed read/bash/edit/write/grep/find/ls request/result range, mirrors finalized display-only todo/plan state, and strips OpenCode 1.x and OpenCode 2 read envelopes before returning content to Cursor.
- **Thinking / reasoning** — surfaces extended-thinking deltas where the model supports it

## Requirements

- [Bun](https://bun.sh) (for development and tests)
- [OpenCode](https://opencode.ai), or a supported host configured through [OCP](https://github.com/oakimov/opencode-plugin-compat)
- An active Cursor account with API access

## Installation

This package is one plugin with host-specific entrypoints. Use the guide for your OpenCode major version:

| Host | Guide |
|------|--------|
| **OpenCode 1.x** | [docs/opencode-1.md](docs/opencode-1.md) — classic `plugin` plus optional 1.18 `plugin/v2` |
| **OpenCode 2.0** | [docs/opencode-2.md](docs/opencode-2.md) — `plugin/opencode2` only, including [safe transition](docs/opencode-2.md#safe-transition) off `ctx.catalog` and the deprecated `opencode.json` catalog dump |
| **Other agents** | [Coding-agent compatibility](#coding-agent-compatibility) |

Do not load the 1.x and 2.0 entrypoints in the same host.

OpenCode 1.x (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["cursor-opencode-provider"]
}
```

OpenCode 2.0 (prefer a dedicated `OPENCODE_CONFIG_DIR`):

```json
{
  "plugin": ["cursor-opencode-provider/plugin/opencode2"]
}
```

Local clones, 1.18 `plugin/v2`, config isolation, and leftover `providers.cursor` cleanup are in the host guides. Shared catalog behavior (variants, 1M, Fast, images, Max Mode) is under [Select a model](#select-a-model).

```bash
git clone https://github.com/oakimov/cursor-opencode-provider.git
cd cursor-opencode-provider
bun install
bun run build
```

You can also install from npm (`npm install cursor-opencode-provider` or `bun add cursor-opencode-provider`). Pin a version in host config if you want, for example `cursor-opencode-provider@0.4.1`.

## OpenCode setup

Host config, auth commands, and local-clone wiring differ by major version — follow [OpenCode 1.x](docs/opencode-1.md) or [OpenCode 2.0](docs/opencode-2.md).

### Authenticate

| Host | How |
|------|-----|
| **OpenCode 1.x** | `opencode auth login` → **cursor** ([details](docs/opencode-1.md#authenticate)) |
| **OpenCode 2.0** | `/connect` → **Cursor** ([details](docs/opencode-2.md#authenticate)). `CURSOR_API_KEY` is also picked up automatically. |

Then choose a method:

| Method | Description |
|--------|-------------|
| **Cursor account (browser login)** | PKCE OAuth — opens cursor.com to sign in |
| **API key** | Paste a key from [cursor.com/settings](https://cursor.com/settings) (`crsr_...`) |

After login, the plugin fetches your available models and writes them to `<host-cache>/cursor-models.json`. On later startups, a missing, empty, expired, or old-schema cache is refreshed during config load when Cursor auth is available; an existing stale cache remains usable if refresh fails. Completed conversation state is stored separately under `<host-cache>/cursor-conversations/`, with one independently replaced gzip-compressed protobuf snapshot per stable host session. Snapshots are refreshed at each successful Cursor `TurnEnded` and restored after provider restarts; records not updated for more than 24 hours are removed when the provider starts. Cursor's checkpoint is an index of content-addressed KV blobs rather than a self-contained transcript, so the snapshot retains the blobs reachable from the latest checkpoint and discards superseded blobs. This private Cursor state is not a copy of the host's session database.

### Paths (host cache)

Model/version caches and Cursor project metadata live under a **host cache root**, resolved in this order:

1. Explicit `createCursor({ cacheDir })` / host API cache override
2. A structural host path bridge installed before the provider loads
3. Native OpenCode: `$XDG_CACHE_HOME/opencode`, otherwise `~/.cache/opencode`

The provider never detects or names fork hosts. Compatibility layers own host identity and may inject cache, data, and config roots through the structural bridge; without one, standalone OpenCode behavior is unchanged.

| Kind | Default (OpenCode) | Notes |
|------|--------------------|-------|
| Model, version, and 24-hour conversation **cache** | `~/.cache/opencode/` | A host bridge may replace the root |
| Cursor **project metadata** (`agent-tools`, terminals, …) | `~/.cache/opencode/projects/<slug>/` | under `<host-cache>/projects/` |
| OpenCode **auth** (`auth.json`) | `~/.local/share/opencode/` | `$XDG_DATA_HOME/opencode/` when set |
| OpenCode **config** (AGENTS, skills, …) | `~/.config/opencode/` | `$XDG_CONFIG_HOME/opencode/` when set, as OpenCode resolves it |

### Select a model

Pick a model from the cached list (for example `composer-2.5`, `default`, or a Claude/GPT model exposed by your subscription):

```bash
opencode run --model cursor/composer-2.5 "Hello from Cursor via OpenCode"
```

#### Variants

Cursor models often expose parameterized variants (effort, thinking, fast, context tier, …). The plugin materializes those as OpenCode **model variants**. In the TUI, pick one from the variant dialog or cycle with OpenCode’s `variant_cycle` keybind (default `ctrl+t`).

The selected variant’s Cursor parameter map is forwarded on the Run as `requested_model.parameters` (isolated under `providerOptions.cursor.cursorVariantParameters` so unrelated OpenCode options are not leaked onto the wire). The provider validates that explicit selection against the current cached tuple; malformed, reordered, or stale selections fail clearly instead of silently falling back to another variant.

#### 1M / long context

OpenCode’s context limit is static per model entry, while Cursor’s long-context tier is a variant parameter (`context=1m`). When a model has both a base tier and a `1m` tier, the plugin emits a separate OpenCode entry `<model-id>-1m` (for example `claude-opus-4-8-1m`) with:

- `limit.context` set to the 1M window (so overflow checks and compaction match the tier)
- `limit.output` set to `128000` (max generation tokens — not the context window; base entries use `32000`)
- only the long-context variants in its picker
- the real Cursor model id carried in `options.cursorModelId` (not `config.id`, which would make OpenCode merge base variants into the 1M entry)

The Run still uses Cursor’s original model id; OpenCode’s synthetic `-1m` id is only for picking and limits.

#### Fast variants with distinct prices

When Cursor publishes a different Fast rate for a model (currently Composer and Grok), the plugin emits a separate OpenCode entry `<model-id>-fast` (for example `composer-2.5-fast`) using the same pattern as `-1m`:

- only the Fast variants in its picker, with `" Fast"` in the catalog name
- the real Cursor model id in `options.cursorModelId`, plus default Fast variant parameters
- its own `cost` row (`composer-2.5-fast` is not nested under `composer-2.5`)

Claude Fast variants stay on the base entry: Cursor does not publish a separate Fast price for them, so they remain picker variants instead of a second catalog id. Combinations with long context use `<id>-1m-fast`.

#### Context limit sources

The provider resolves each catalog context limit in this order:

1. Live `AvailableModels` metadata (variant `context` parameters first, then context-limit fields)
2. Cursor’s published model table, generated from [`docs.md`](https://cursor.com/docs.md) alongside pricing data
3. A conservative `200000` fallback when neither source publishes a limit

The docs fallback only fills static catalog metadata. It does not invent Cursor variants or enable a long-context tier that `AvailableModels` did not advertise.

#### Model families

Catalog entries derive a models.dev-style `family` from the Cursor model id (`claude-haiku-4-5` → `claude-haiku`, `gpt-5.6-luna` → `gpt-luna`). Version segments and trailing `-1m` / `-fast` suffixes do not split families; Kimi keeps its major generation (`kimi-k2.7-code` → `kimi-k2`). Auto (`default`) has no derived family. A non-empty family supplied in cached model metadata takes precedence; the live `AvailableModels` schema has no family field.

OpenCode uses family metadata to select a small model for session titles (2.0: `gpt-luna`, `gemini-flash-lite`, `gemini-flash`, `claude-haiku`; 1.x: `gemini-flash`, `gpt-nano`, `claude-haiku`). If no eligible family is available, titles fall back to the session model. To override this selection, set the `title` agent's `model` on either major, or `small_model` on 1.x. Compaction summaries use the host's compaction model selection; this metadata does not move them to the small model. OpenCode 2's model-listing tool shows one entry per family unless asked for all.

#### Image input

The provider advertises `text` + `image` input only when the selected Cursor model supports images; model output remains text. This works in the classic plugin, the 1.18 v2 plugin, and OpenCode 2.0.

Image support is resolved in this order:

1. Live `AvailableModels.supportsImages` metadata, including authoritative `false` values
2. The `Capabilities` column in Cursor's [`docs.md`](https://cursor.com/docs.md), generated alongside context and pricing metadata
3. Text-only when neither source describes the model

OpenCode image file parts are decoded from bytes, base64/data URLs, local file URLs, or HTTP(S) URLs and sent through Cursor's `UserMessage.selected_context.selected_images` field. Fresh and rebased Runs normalize the same image formats as held-Run continuations, including AI SDK `image-data` / `image-url` and OpenCode attachment URLs. Previously sent history images are deduplicated by content hash per OpenCode session.

On a held-open Run, an image read returns bytes in `ReadSuccess.data` (including GenerateImage reference reads), and MCP tool images return as `McpImageContent` items after the success text (`McpToolResultContentItem` field 2). Detached media is attributed only where OpenCode's result order and markers establish its owner; ambiguous images stay available through history instead of being attached to an unrelated tool. A host instruction update beside a native read uses Cursor's context-injection channel because read text and bytes are mutually exclusive.

One 20 MiB decoded-byte budget covers all image-bearing pending results in a continuation, without Cursor CLI's resize/re-encode step. Unreadable or oversized tool images are reported without blocking other results; cancellation still stops decoding. Other result shapes have no image field, so their images reach Cursor as history on the next fresh Run. Direct PDF, audio, and video attachments are unsupported; tool-result delivery only forwards image media.

#### Max mode

Cursor IDE has a separate **Max Mode** toggle that sets `requested_model.max_mode` and selects the default max / 1m variant. OpenCode has no equivalent custom toggle, so this provider approximates it:

- Selecting a `*-1m` model (or any resolved params with `context=1m`) sets wire `max_mode` to `true`
- An explicit `providerOptions.cursor.maxMode` hint also turns it on

There is no independent Max Mode chrome in OpenCode beyond choosing the 1M model / long-context variant.

## Programmatic usage

```ts
import { createCursor } from "cursor-opencode-provider"

const cursor = createCursor({
  name: "cursor",
  accessToken: process.env.CURSOR_ACCESS_TOKEN,
  // apiBaseURL: "https://api2.cursor.sh",
  // agentBaseURL: "https://agentn.us.api5.cursor.sh", // explicit Run host override
  // telemetryEnabled: true, // opt in to GetServerConfig telemetry
  // cacheDir: "/path/to/host/cache", // optional; else active-host heuristic
  // retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 },
  // continuation: { heartbeatMs: 5_000, semanticIdleMs: 120_000, hardCapMs: 600_000 },
})

const model = cursor.languageModel("composer-2.5")
// model implements AI SDK LanguageModelV3 (doStream / doGenerate)
```

Give one credential source. The provider uses the first present and never falls back from one to another: `getAccessToken` (an async function returning the current access token, called for every Run so a long-running process can renew its login; it receives `{ forceRefresh: true }` once after Cursor rejects a token), then `accessToken` (a JWT sent as-is, never renewed), then `apiKey` (a raw `crsr_...` key, exchanged for a JWT and exchanged again near its expiry, the way Cursor CLI renews an API-key login). Optional: `apiBaseURL`, `agentBaseURL`, `cacheDir`, `headers`, `telemetryEnabled`, `retry`, and `continuation`. `cacheDir` pins the host cache root for model/version caches and Cursor project metadata; when omitted, the provider uses an injected structural host path bridge or the native OpenCode XDG cache described in [Paths](#paths-host-cache). Transient failures resume from the latest checkpoint produced by that Run, matching Cursor CLI; without an eligible checkpoint, retries remain limited to replay-safe attempts so completed text or tool work is not duplicated. Once that budget is spent, or replay is unsafe, the terminal error does not re-arm OpenCode's outer retry loop. Pending-tool inactivity is renewed by OpenCode activity from the session or its descendants. The older `baseURL` option is still accepted as a legacy alias for `agentBaseURL`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CURSOR_WEBSITE_URL` | Override OAuth login base URL (default `https://cursor.com`) |
| `CURSOR_API_BASE_URL` | Override API base for auth, model discovery, and `GetServerConfig` agent URL resolution (default `https://api2.cursor.sh`) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Set to `1` or `true` to opt the `GetServerConfig` lookup into telemetry in OpenCode/plugin usage |
| `HTTPS_PROXY` / `https_proxy` | HTTP CONNECT proxy for HTTPS. Bun `fetch` uses this for unary RPCs; the Run HTTP/2 session also tunnels through it (see `NO_PROXY`). The Run tunnel supports only `http://` proxy URLs (Basic auth via userinfo); `https://` and SOCKS proxy URLs leave the Run on a direct connection. `HTTP_PROXY` is not used for HTTPS |
| `NO_PROXY` / `no_proxy` | Comma/space hosts that bypass the proxy (`*`, exact host, or `.suffix` / `suffix` domain forms; a `host:port` entry bypasses only that port) |
| `CURSOR_PROVIDER_DEBUG` | Set to `1` or `true` to enable wire-level debug logging |
| `CURSOR_PROVIDER_DEBUG_FILE` | Debug log path (default: `debug-<pid>.log` under `$TMPDIR/cursor-provider-logs-<uid>/`) |
| `CURSOR_OPENCODE2_DEV_ENTRY` | **Local OpenCode 2.0 only.** Absolute path to a built entry file (usually `dist/index.js`). Rewrites the AI SDK package to `aisdk:file://…` so the daemon imports your local build instead of `npm install`-ing the published package. Export it **before** `opencode2 service start`, then restart after rebuilds. Unset in production. See [OpenCode 2.0 local clone](docs/opencode-2.md#from-a-local-clone-cursor_opencode2_dev_entry). |
| `CURSOR_OPENCODE2_TODOS` | **OpenCode 2.0 only.** Set to `1` or `true` to register plugin-owned `todowrite`/`todoread` (in-memory; no TUI sidebar). Off by default. OpenCode 1.x still uses the host builtin. |
| `XDG_CACHE_HOME` | Base for native OpenCode cache (`$XDG_CACHE_HOME/opencode/`) when no explicit `cacheDir` or structural host path bridge is installed |
| `XDG_DATA_HOME` | When set, OpenCode `auth.json` is read from `$XDG_DATA_HOME/opencode/` instead of `~/.local/share/opencode/` |

`createCursor({ agentBaseURL })` overrides the agent Run host. When unset, the provider resolves the host from Cursor's `GetServerConfig` API (`agentUrlConfig.agentnUrl`, region-specific — e.g. `agentn.us.api5.cursor.sh`, `agent-gcpp-uswest.api5.cursor.sh`) once per process and holds it in memory (never written to disk), so a held-open Run stream is never repointed mid-session. Explicit agent overrides and GetServerConfig results are validated as HTTPS `*.cursor.sh` hosts (Cursor's agent hostnames vary and may change); non-`cursor.sh` hosts are rejected. Shared HTTP/2 connections are rotated before they become server-aged, while existing Runs may finish on their original connection. The lookup sends `{ "telem_enabled": false }` by default; set `telemetryEnabled: true` in provider config, or `CURSOR_GET_SERVER_CONFIG_TELEMETRY=1` for OpenCode/plugin usage, to opt in. If the lookup fails or does not return a valid Cursor agent host, the model call fails clearly instead of falling back to `agentn.global.api5.cursor.sh`.

## Development

```bash
bun install          # install dependencies
bun run build        # compile TypeScript → dist/
bun run typecheck    # type-check without emit
bun test             # run unit tests
bun run test:node-http2 # Node-specific HTTP/2 detach regression
bun run test:watch   # watch mode
bun run generate:pricing  # refresh src/pricing-data.ts from Cursor docs
bun run check:pricing     # fixture coverage for known model ids
```

**HARD STOP before any version bump or `v*` tag:** run `generate:pricing` and `check:pricing` in the same session, fix any unmapped Cursor display names, commit mapping/`pricing-data.ts` updates, and finalize [`CHANGELOG.md`](CHANGELOG.md) (`[Unreleased]` → dated version) **before** touching `"version"` or creating the tag. Publish CI regenerates rates from the live docs and will fail the release on an unmapped name — that is a last line of defense, not the primary check. See `AGENTS.md` and [Changelog](#changelog).

## Architecture

```
OpenCode
  └── CursorPlugin (auth, model cache, config hook)
        └── createCursor() → LanguageModelV3
              ├── session.ts  held-open Run stream + exec bridge
              ├── protocol/   protobuf messages, framing, tools, thinking
              └── transport/  Connect-RPC over HTTP/2 to Cursor's agent backend
```

| Module | Role |
|--------|------|
| `src/plugin.ts` | Classic OpenCode hooks: provider registration, OAuth, API key exchange, login renewal and persistence |
| `src/plugin-v2.ts` | OpenCode 1.18 Effect/Promise v2 plugin (`ctx.aisdk.*`); load via `./plugin/v2` only |
| `src/plugin-opencode2.ts` | OpenCode 2.0 plugin (`provider.transform`, integration, tools, aisdk, `shell.create.before`, `websearch`); load via `./plugin/opencode2` or `./server` |
| `src/opencode2/` | 2.0-only provider inventory, integration/auth, and local API types |
| `src/plugin-core.ts` | Host-neutral SDK factory, package matching, API base/telemetry resolution |
| `src/model-config.ts` | Cursor model → OpenCode model mapping shared by every plugin surface |
| `src/image-input.ts` | AI SDK image attachment validation, decoding, and size limits |
| `src/pricing.ts` / `src/pricing-data.ts` | Cursor docs token rates → classic `cost` and OpenCode 2.0 cost tiers |
| `src/index.ts` | `createCursor` factory; default export is `CursorPlugin` |
| `src/language-model.ts` | AI SDK `LanguageModelV3` adapter (`doStream`, `doGenerate`) |
| `src/session.ts` | Held-open agent Run session and pending exec correlation |
| `src/debug.ts` | Opt-in wire-level debug logging (`CURSOR_PROVIDER_DEBUG`) |
| `src/auth.ts` | PKCE OAuth, API key exchange, browser-login session refresh (`/oauth/token`) |
| `src/auth-renewal.ts` | Credential renewal policy: session and API-key renewal kept separate, backoff, on-demand renewal, Bearer resolution |
| `src/models.ts` | `AvailableModels` fetch and `cursor-models.json` cache |
| `src/protocol/conversation-persistence.ts` | Atomic per-session restart snapshots under the 24-hour `cursor-conversations/` cache |
| `src/context/paths.ts` | Host cache root + Cursor project metadata under `<host-cache>/projects/<slug>/` |
| `src/agent-url.ts` | `GetServerConfig` fetch + in-process memo (region-specific Run host) |
| `src/transport/connect.ts` | HTTP/2 bidi stream and unary RPC calls |
| `src/transport/https-proxy.ts` | `HTTPS_PROXY` / `NO_PROXY` CONNECT tunnel for Run sessions |
| `src/protocol/` | Protobuf encode/decode, checksum/device ids, exec + display tool-call mapping (`tool-call-bridge.ts`) |

### Injected system guidance

The provider adds OpenCode-specific system guidance to normal tool-capable conversations, including tool availability, canonical workspace-path grounding, preferring OpenCode `todowrite` / `todoread` over Cursor TodoWrite when those tools are advertised without inviting catalog-comparison narration, and preferring `edit` / `write` (or `apply_patch`, when the host advertises that instead) over shell-based file mutation when those tools are available. Compaction keeps its dedicated prompt unchanged.

Cursor keeps OpenCode `skill` and configured MCP tools off its native top-level function list on **both** OpenCode 1.x and OpenCode 2.0 — they appear as names-only MCP descriptors and are reached through GetDynamicTools / CallDynamicTool (exec #36 supplies full definitions). When the host advertises `skill` and/or tools of MCP servers configured in `opencode.json`, the provider names those routes in system guidance and mirrors OpenCode's load-when-matches / do-not-reinvoke rules so models prefer `skill` / MCP over Grep/Shell and do not narrate that those tools are unavailable. When the host advertises `skill`, skills that have a usable file path are also listed in RequestContext `agent_skills` (path and description only), as Cursor's own clients list them. Skill catalog changes after admission are host `<system-update>` notes; `agent_skills` follows the baseline catalog until the next epoch. OpenCode 2 still moves MCP servers that did not set `"codemode": true` onto the direct AI SDK catalog first; without that placement they never reach Cursor's MCP ads at all (see [OpenCode 2 MCP tools](docs/opencode-2.md#mcp-tools)).

Each discovered dynamic definition carries its exact `namespace` and `toolName` in its description. Keep those fields at the outer level of every `CallDynamicTool` call; the discovered input schema describes only its `arguments` object.

Native Cursor todo display updates (`update_todos_tool_call` / `read_todos_tool_call`) are mirrored into `todowrite` / `todoread` when those host tools are advertised. OpenCode 2 dropped the host builtins; set `CURSOR_OPENCODE2_TODOS=1` (or `true`) to register the same canonical names when the catalog omits them (in-memory per session, cleared on `session.deleted` and process restart). With the flag unset, the plugin registers no todo tools. Enabled plugin tools are **direct** catalog tools (`options.codemode: false` plus an `output` schema), not Code Mode helpers. The provider retains the last known full list per OpenCode session — refreshed by bridged writes, direct host `todowrite` calls, and `todoread` results, surviving Run close, checkpoint resume, and later turns — so `merge: true` updates that omit Cursor's completed list still become a host replace-all snapshot (matched by id, then by content across id spaces). This snapshot is in-memory only and never enters the prompt, RequestContext, or persisted restart state, so Cursor's prompt-cache prefix is unaffected; a provider process restart clears it until the next write/read (intentional — see `tasks/lessons.md`).

If this guidance causes issues, update `buildOpenCodeInteractionGuidance` in [`src/language-model.ts`](src/language-model.ts) and its focused coverage in [`test/prompt-history.test.ts`](test/prompt-history.test.ts).

### Cursor edit handshakes

Cursor's legacy `edit_tool_call` is implemented internally as a correlated `read_args` followed by a whole-file `write_args`; the write is transport mechanics, not a new decision to replace OpenCode's `edit` tool. For regular files inside the workspace, the provider answers that private prerequisite read directly with the complete file (up to Cursor's own 50 MB edit limit), because routing it through OpenCode's ordinary 50 KB-capped `read` tool makes Cursor calculate a truncated replacement. This shortcut is restricted to the exact path named by the active edit call and rejects symlink escapes. External paths first take OpenCode's permission-aware read path; after that exact read succeeds, the provider upgrades its private result to complete content so an explicitly authorized external edit does not inherit OpenCode's preview cap.

The provider retains the correlation and exposes the resulting existing-file mutation as one unique, line-bounded OpenCode `edit`. It still returns Cursor's expected typed `write_result`. New-file creation remains a `write`, and an `apply_patch`-only catalog receives the same targeted change as an `*** Update File:` patch.

Ordinary complete native reads also preserve an existing final LF/CRLF. OpenCode's numbered read envelope cannot represent that terminator, and dropping it made exact edit matching fail. This restoration applies only to confirmed-complete, unbounded reads; paged and capped reads keep their existing truncation behavior.

### `apply_patch` models (GPT-5 and friends)

OpenCode 1.x does not simply add `apply_patch` for GPT-series models — it **removes** `edit` and `write` from the tool catalog and advertises `apply_patch` in their place (`ToolRegistry.tools`; the model id must contain `gpt-` and neither `oss` nor `gpt-4`). Cursor keeps sending its native write/edit requests regardless, so without translation every file change on a `gpt-5*` model is refused as an unavailable tool.

The provider translates transparently: an uncorrelated native write becomes an `*** Add File:` patch, while a correlated legacy edit or Pi edit becomes a minimal `*** Update File:` chunk widened to whole lines. This is keyed purely off what the host advertises — it is inert whenever `edit`/`write` are offered normally, and inert again when the host offers neither those nor `apply_patch`. An edit that cannot be expressed faithfully (target unreadable, or the text to replace is absent or ambiguous) is refused with a specific message rather than applied to the wrong region.

OpenCode 2.0 does not perform this substitution, so the path is 1.x-only in practice. See [`src/protocol/apply-patch.ts`](src/protocol/apply-patch.ts) for the upstream references.

### Native subagent routing

The provider reads the permission-filtered subagent catalog from the current host `task` or `subagent` definition and advertises those recipients to Cursor as custom subagents. Native Cursor Task exec remaps onto `task` when advertised, otherwise onto OpenCode 2 `subagent` (`agent` / `sessionID` / `background`). Exact configured names are preserved; unknown future Cursor subtype strings fall back to `general`. If a complete catalog omits every compatible recipient, the request fails on Cursor's typed subagent channel instead of selecting an arbitrary specialist.

| Host | Executor | Recipients |
|------|----------|------------|
| OpenCode 1.x | `task` | Permission-filtered builtins such as `general` / `explore`, plus configured subagents |
| OpenCode 2.0 | `subagent` | The permission-filtered names listed by the host's tool definition |

Primary modes and hidden/internal agents are never selected unless OpenCode explicitly exposes them as spawnable. Alternate-host agents and schemas are OCP responsibilities; see its host guides under [Coding-agent compatibility](#coding-agent-compatibility).

## Package exports

| Import path | Export |
|-------------|--------|
| `cursor-opencode-provider` | `createCursor`, `CursorPlugin` (named + default) |
| `cursor-opencode-provider/plugin` | `CursorPlugin` (classic Hooks — auth) |
| `cursor-opencode-provider/plugin/v2` | OpenCode 1.18 Effect/Promise v2 plugin (`ctx.aisdk.*`) |
| `cursor-opencode-provider/plugin/opencode2` | OpenCode 2.0 plugin (self-registering: models + auth + tools) |
| `cursor-opencode-provider/server` | Same OpenCode 2.0 entry; OpenCode 2 Host.resolve and OpenCode 1.18 `exports["./server"]` |
| `cursor-opencode-provider/errors` | Structured provider error classes |
| `cursor-opencode-provider/image-save` | Host-neutral `executeCursorImageSave` (pi-bridge / non-plugin hosts) |

The package root intentionally stays plugin-safe for OpenCode's classic loader. `CursorPluginV2` and non-plugin runtime APIs are **not** re-exported from the package root; load them through their dedicated subpaths.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No Cursor models in the picker (OpenCode 1.x) | Confirm Cursor auth (`opencode auth login` → **cursor**). Restart OpenCode — if auth is present and the cache is empty, models are fetched on startup. Confirm `provider.cursor.npm` is the package name (or a built `file://…/dist/index.js`). See [OpenCode 1.x troubleshooting](docs/opencode-1.md#troubleshooting). |
| No Cursor models in the picker (`opencode2`) | Confirm `/connect` → **Cursor** (or shared `auth.json`). Use a dedicated `OPENCODE_CONFIG_DIR` (not mixed with 1.x). Ensure `$OPENCODE_CONFIG_DIR/plugins/cursor/` is a package directory re-exporting `plugin/opencode2` (not a bare `.js`). After auth, Cursor models appear in the picker from the in-memory inventory — no `opencode.json` model list is required. Filter by provider **Cursor** (`time.released` is `0`, so models sort last). Leftover `providers.cursor` fights that inventory — [safe transition](docs/opencode-2.md#safe-transition). |
| Auth / 401 errors mid-session | Logins renew themselves: a browser login (60-day session) is renewed through Cursor's `/oauth/token` once less than 1272 h of it remain, as Cursor's IDE decides, whenever a request needs a token (there is no background timer, as with OpenCode's own OAuth providers); an API-key login exchanges its stored key again within five minutes of the exchanged JWT's expiry, as Cursor CLI does. The two never stand in for each other. Sign in again when the error says the session was ended, the key was rejected, or a sign-in policy blocks it. An API-key login saved before the key was kept (`metadata.apiKey`) cannot be renewed and needs one fresh API-key sign-in. Renewal attempts and failures go to the debug log (`CURSOR_PROVIDER_DEBUG`). |
| Local OpenCode 2.0 still runs the published package | Set `CURSOR_OPENCODE2_DEV_ENTRY` to an absolute `…/dist/index.js` path **before** starting the daemon, persist it with `opencode2 service set env CURSOR_OPENCODE2_DEV_ENTRY …`, rebuild (`bun run build`), then `opencode2 service restart`. Loading only `dist/plugin-opencode2.js` is not enough — without the env var, 2.0 still `npm install`s the published package into the host cache. |
| “Too many connections from different devices” | Device IDs are derived from stable OS identifiers (same approach as the Cursor CLI). Avoid running multiple clients that invent different machine fingerprints for the same account. |
| Empty or stale model list | Delete `<host-cache>/cursor-models.json` (native default `~/.cache/opencode/`) and restart OpenCode. A compatibility layer may supply a different host-cache root through the structural path bridge. Existing Cursor auth is enough to refill the cache; re-login only if auth itself is broken. Cache TTL is 24h; a failed background refresh keeps serving the previous cache. |
| Stream hangs or HTTP/2 errors | The provider keeps Cursor's Run open across OpenCode tool calls, rotates aged shared connections, resumes transient interruptions from the latest eligible Cursor checkpoint, and falls back to a fresh-history rebase only before stateful output when no checkpoint exists. Repeated interruption is surfaced as an error instead of a false successful stop; retry the turn after checking connectivity. Behind an HTTP proxy, set `HTTPS_PROXY` (and `NO_PROXY` as needed): unary `fetch` and the Run HTTP/2 CONNECT tunnel both honor them. With debug logging enabled, look for `Run interrupted`, `resuming … checkpoint`, `rebasing fresh Run`, or `h2 connect via HTTPS proxy`. Restart OpenCode after rebuilding a local `file://` install. |
| No response / silent 200 + close | HTTP 200 alone is not a successful agent turn: the provider now requires Cursor's explicit `turn_ended`, captures HTTP/2 trailers/GOAWAY, and recovers once from bare EOF. The Run host still comes from in-memory `GetServerConfig` resolution; set `CURSOR_PROVIDER_DEBUG=1` to confirm the host and termination reason. |
| Visible `<shell_metadata>` timeout text | Rebuild and restart a local install. Cursor's shell timeout is carried on its exec request; the provider now removes OpenCode's internal timeout envelope before it is rendered or stored, then returns Cursor's typed timeout or background-handoff event instead of treating the text as successful stdout. |
| `Unsupported Cursor exec variant …` | The error names the canonical Cursor CLI request field, its expected result field, and this provider's handling classification. Known `handling=unsupported` variants (Cursor-native capabilities without a safe OpenCode AI SDK bridge) are now soft-denied on the wire with a populated typed error/`rejected`/`allowlisted:false` result and the Run continues — look for `exec: SOFT-DENIED …` in the debug log and a `Workspace root: …` suffix in the deny text — while `unknown request field` still hard-fails as protocol drift; `handling=opencode-tool` or `provider-control` indicates a provider decoder/dispatch regression. Enable the debug log and report the full named error. |
| Need wire-level logs | Set `CURSOR_PROVIDER_DEBUG=1` (optional `CURSOR_PROVIDER_DEBUG_FILE`; the default is `debug-<pid>.log` under `$TMPDIR/cursor-provider-logs-<uid>/`) and reproduce the issue. Every completed turn emits a `turn usage validation: status=ok|mismatch` line confirming token-accounting integrity and a `cache diagnosis:` line showing warm/cold checkpoint continuity, raw read/write/uncached tokens, cache-read coverage of the prior context, context/category deltas, stable RequestContext hashes, and Run step/tool counts. Checkpoint lines include Cursor's current category totals. Cursor does not expose per-model-call cache splits, so the diagnostic labels that value unavailable instead of inferring it from aggregate `TurnEnded` counters. |
| OpenCode token totals stay stuck until the turn ends | OpenCode TUI/GUI display the last assistant message with non-zero output, they do not sum occupancy. Tool-call steps emit Cursor's last-known checkpoint occupancy (with `output > 0` so the footer accepts it) and `providerMetadata.copilot.totalNanoAiu: 0` so those snapshots are not billed. The billed occupancy is emitted once at `TurnEnded`. If a checkpoint has not arrived yet, the previous turn's occupancy stays visible as stale. With no known snapshot, usage stays zero instead of mislabeling estimates or `TurnEnded` as context. Raw request counters remain in `providerMetadata.cursor`. |
| Context percentage jumps after a long tool turn or compaction | Cursor reports its authoritative context snapshot in checkpoint `token_details`. The provider makes AI SDK input + output equal `usedTokens`, proportionally partitions input into cached/uncached subsets, and exposes `maxTokens`, percentage, and category breakdown under `providerMetadata.cursor.context`. Mid-turn tool steps publish that occupancy as a display-only snapshot; compaction naturally replaces the prior snapshot with Cursor's smaller total. |
| Cache **write** tokens always show as `0` | Cursor's `TurnEnded` protobuf includes `cache_write` (field 4), but captured Runs set it to `0` even when `cache_read` is large. The provider forwards the request-local value when Cursor supplies one; it cannot infer a missing write count. With debug logging, confirm `turn_ended raw wire fields: … f4:wt0=0`. |

## Security

Project `instructions` may reference absolute or `~/` paths (OpenCode parity). See [SECURITY.md](./SECURITY.md) for the trust model and `OPENCODE_DISABLE_PROJECT_CONFIG`.

## Known limitations

- **Native planning calls and handoffs** — CreatePlan and SwitchMode use their already supplied native function definitions, never dynamic discovery or CallDynamicTool. Where an approved switch resumes in the host's plan agent after the current turn, that turn ends before any further tool call; the following plan turn records the plan. Debug logs include server-side native discovery errors as well as MCP invocation errors, without replaying either as host execution.
- **Personal use / ToS** — this provider speaks Cursor’s private agent protocol (CLI-shaped client identity). Use only with an account you own; Cursor may change or restrict the API without notice.
- **Cursor's checkpoint controls displayed totals** — live continuation captures show `TurnEnded` counters can decrease between turns and can represent aggregate model work rather than final context occupancy. When a checkpoint contains `ConversationStateStructure.token_details`, the provider makes AI SDK input + output equal Cursor's `used_tokens`; at `TurnEnded`, output/reasoning remain based on `TurnEnded`, while uncached/cache-read/cache-write input are proportionally normalized to the remaining context input. OpenCode TUI/GUI replace each assistant message's tokens (TUI requires `tokens.output > 0`) and add cost per step, so mid-turn tool boundaries emit the last-known occupancy snapshot rather than a delta or a billed zero. Those snapshots set `output=1` so the footer updates and `providerMetadata.copilot.totalNanoAiu: 0` so OpenCode's getUsage reports $0 instead of charging occupancy as a new prompt. A Run without fresh token details retains the previous checkpoint snapshot and marks `providerMetadata.cursor.context` as `source: "checkpoint-previous-turn", stale: true`. If no checkpoint has ever supplied token details, standard usage is zero and context metadata is absent, so `TurnEnded` is never misrepresented as occupancy; its exact values remain under `providerMetadata.cursor.*Raw`. The full known snapshot includes `usedTokens`, `maxTokens`, percentage, category breakdown, source, and staleness. Cursor consistently sends `cache_write=0` in captured Runs, so no alternate write count is available.
- **`request_context` from OpenCode** — each Run sends Cursor `RequestContext` with OpenCode's system prompt (its `AGENTS.md` / `instructions`, skill list, MCP instructions) plus the provider's interaction guidance as one always-apply rule, workspace env, git, layout, host-advertised `task`/`subagent` names, names-only tool overlay, and plugin lines. Cursor does not follow a client-seeded `system` message or an untyped rule, so the always-apply (`global`) rule is the channel that makes `AGENTS.md` effective; the provider does not read instruction or skill files itself. Merged `opencode.json` is still read for MCP server ids, plugin lists, and interaction guidance. Expensive workspace state (environment, repository, git, and layout) is frozen per Cursor conversation and persisted for restart recovery. Tools/MCP names, host subagents, and plugin metadata are rediscovered each Run then epoch-held (equal ids keep frozen bytes; new ids append); unchanged overlays reuse byte-identical encoded context. Concurrent first Runs share one base build, and compaction/reset clears it. Its canonical root is also used by the [injected system guidance](#injected-system-guidance). Cursor-only cloud/sandbox marketplace surfaces are omitted. `env.workspace_paths` / `process_working_directory` stay on the real git workspace; Cursor's metadata root (`project_folder`, MCP `workspace_project_dir`, terminals/transcripts) is advertised under `<host-cache>/projects/<slug>/` (default `~/.cache/opencode/projects/…`) so dumps like `agent-tools/` do not land in the repo. OpenCode remains the permission authority: its coarse allow/ask/deny configuration is not fabricated into Cursor's unrelated allow/block instruction-list messages.
- **Configured MCP tools keep their upstream server id** — OpenCode builtins and plugin/custom tools are advertised under a synthetic `opencode` MCP server. Tools whose flattened name matches an MCP server in merged `opencode.json` configuration (`github_create_pull_request`, …) are grouped into that server's `mcp_descriptors` / `provider_identifier` (`github`, …). Unknown underscore-containing names stay under `opencode` rather than being guessed incorrectly. Cursor's MCP-state exec probe is answered from the same advertised descriptors before the actual tool request, using the full canonical tool-definition identity required by native `get_mcp_tools` / GetDynamicTools; exec still reconstructs the full OpenCode tool id. That discovery call is Cursor-native (not an OpenCode catalog tool). Oversized catalogs spill through `write_args` into `agent-tools/<uuid>.txt`; `WriteSuccess.path` echoes the requested path so the model receives a real `filePath` instead of an empty spill.
- **Display completions are notifications, not execution requests** — Cursor `tool_call_*` frames use a typed `ToolCall` oneof. The provider decodes them for diagnostics but only mirrors finalized todo/plan state (`update_todos_tool_call` → `todowrite`, `read_todos_tool_call` → `todoread`, `create_plan_tool_call` → `todowrite`); the completed payload already contains the authoritative final list. Interactive, data-returning, and side-effecting completions are never replayed as new tools because their result could not be returned to Cursor. Exec-backed native subagent/Task and Pi read/bash/edit/write/grep/find/ls calls use their typed request/result fields instead. Unknown display variants are logged. All 37 Cursor CLI exec request/result pairs are inventoried by field and name. Known-but-unsupported variants are soft-denied on the held Run with a populated typed error/`rejected`/`allowlisted:false` result (or `throw` when the CLI has no typed error shape) so the turn continues; unknown future request fields still fail the Run explicitly rather than receiving a guessed response that could deadlock it.
- **Progress-only fragments can get one continuation** — if a real tool-enabled turn ends with a short progress fragment ("Checking the workspace", "Looking into it now") and no host tool call, the provider opens one follow-up Run with a synthetic user nudge so the model can call a listed tool or finish the answer. Complete answers that merely start with those verbs are not continued. Title/compaction turns (`allowTools=false`) never continue. If the continuation fails, the original `turn_ended` is still reported as a successful stop.
- **Tool availability is per OpenCode agent** — Cursor can request native capabilities such as Task even when a child or restricted OpenCode agent did not advertise the corresponding host tool. The provider prompts Cursor with the exact current catalog and checks every decoded host-tool exec request against it. An unavailable request is answered on Cursor's correlated typed result channel and is never emitted as OpenCode's `invalid` tool.
- **Host web tools use collision-safe aliases** — Cursor sees `custom_websearch` / `custom_webfetch`, and the held Run maps each alias back to an executable OpenCode tool with its schema, permission check, and correlated result intact. OpenCode 2 ships `websearch` as a direct, permission-gated catalog tool; this plugin supplies it an Exa provider through `ctx.websearch.transform` and aliases the host tool for Cursor. It does not add a second direct fallback because OpenCode 2's public plugin tool context cannot raise the host permission prompt. Classic 1.x still registers `custom_websearch` through its permission-aware tool API to avoid OpenCode's reserved `websearch` id filter. Exact host `webfetch` is translated the same way. Cursor's UI-bound native web interactions stay disabled because their approval replies cannot carry OpenCode tool results.
- **MCP resource tools (`list_mcp_resources` / `read_mcp_resource`) also use collision-safe aliases, and Cursor's native resource exec is always answered** — OpenCode's resource tools (advertised only when a connected MCP server declares `capabilities.resources`) share bare names with two of Cursor's own native tool-call variants. Left unaliased, Cursor's client can route a call onto its native exec channel instead of the ordinary MCP tool path, which this provider does not translate — confirmed live: reading a resource was dispatched natively and killed the Run before this fix. The provider now aliases both names to `custom_list_mcp_resources` / `custom_read_mcp_resource` (same mechanism as web search/fetch) so normal calls execute through OpenCode's tools, and separately answers Cursor's native resource-exec fields directly on the protocol floor — an empty list, or a "server not found" error for read — so an unsolicited native request from Cursor can never fail the Run. Downloads (`download_path`) have no OpenCode equivalent and are always refused; binary resource content is subject to the same [50 KB / attachment-type limits](#known-limitations) as other tool results.
- **Background shells are non-interactive** — Cursor's native background-shell spawn and soft-background shell-stream timeouts are bridged through OpenCode's foreground-only `bash` tool. With bash/zsh, the classic plugin keeps the original permission/UI command and executes the wrapper through `shell.env` (`BASH_ENV` / `ZDOTDIR`); OpenCode's non-interactive sh/dash argv ignores those startup variables, so the plugin uses a short `exec /bin/sh '<wrapper-file>'` command backed by the same private wrapper. Native background-spawn requests also carry a self-contained marker-producing fallback when the classic hooks are absent. Spawn/soft-bg wrappers detach with `nohup`, redirect output under `${TMPDIR:-/tmp}/cursor-opencode-{bg,shell}.*`, and return the real PID (or typed timeout/exit) to Cursor. Private markers and OpenCode's `<shell_metadata>` envelope are stripped before storage/render, with a short still-running / started / timed-out status line left for the bash bubble. Requests that require `write_shell_stdin` are rejected explicitly because OpenCode does not expose an interactive background-process lifecycle through its AI SDK tool interface. The POSIX wrap path is not implemented for native Windows PowerShell/`cmd`.
- **Cursor-native AskQuestion reaches you through OpenCode's question tool** — when Cursor asks a clarifying question, the provider translates the interaction into the host `question` tool, so the prompt appears in OpenCode with its real options and your answer is mapped back to Cursor's option ids (an answer you type yourself becomes Cursor's freeform text). Questions Cursor marks as non-blocking are acknowledged immediately and answered later, matching Cursor CLI. If the current agent does not offer `question` — most subagents deny it, and compaction turns have no tools — the request is declined with that reason and the model asks in its reply instead.
- **Cursor-native SwitchMode follows each OpenCode generation's planning model** — on OpenCode 1.x, advertised `plan_enter` / `plan_exit` tools remain authoritative and Cursor waits for their approve/reject result. OpenCode 1.x without `plan_enter` (current releases advertise only `plan_exit`, behind `OPENCODE_EXPERIMENTAL_PLAN_MODE`) is switched into its own `plan` primary agent once the owning Run ends, through a synthetic `session.promptAsync` turn for that agent (only for sessions running one of the primary agents read from `app.agents()`); a CreatePlan raised before that switch is deferred to the plan-agent turn. Inside the `plan` agent, CreatePlan writes the plan to the session's plan file (OpenCode's `Session.plan` location, or the structural path bridge's `planFile`) and runs the `plan_exit` review; OpenCode moving the session to its build agent is the approval. Cursor's own mode follows the OpenCode agent on every turn (`UserMessage.mode`, as Cursor CLI sends it): choosing `plan` in the agent picker puts Cursor in plan mode, and leaving it ends Cursor plan mode. OpenCode 2.0 replaced those tools with vendor-maintained primary `plan` / `build` agents, so its plugin applies an approved Cursor mode change through `session.switchAgent` after the owning Run is terminal; without a `plan_exit` tool, the plan is approved through CreatePlan's `question` prompt (below), and a Cursor SwitchMode out of the host `plan` agent is pointed there. Direct host UI agent switches are also observed. Any real host-agent or stable system-prompt change rotates and reseeds the Cursor conversation instead of resuming an incompatible checkpoint, while title/generation lifecycle prompts remain ephemeral and do not evict the primary cache. Provider-owned Cursor reminders remain the fallback when a host cannot switch agents.
- **Cursor image generation saves through OpenCode's permission where the host API exposes it** — Cursor generates the image on its servers and then writes it like any other file. The provider holds raw bytes and commits them through handle-only `cursor_image_save`. On the classic plugin/OCP surfaces it asks for the same permissions as a normal write (`external_directory`, then `edit`) before saving byte-for-byte. OpenCode 2.0's public plugin `ToolContext` has no permission-request method, so that entrypoint still advertises the tool with catalog `permission: "edit"` and writes after containment. By default images land in the Cursor project folder under `assets/`, kept out of the git tree as agent artifacts. GenerateImage `reference_image_paths` use the same held-Run `ReadSuccess.data` path as an ordinary image `read` (no CLI resize; large refs may still hit the 20 MiB decode budget). The classic implementation is adapted from [`jkalasas/opencode-antigravity-image`](https://github.com/jkalasas/opencode-antigravity-image) (MIT) by jkalasas.
- **Switching models mid-session reseeds Cursor instead of resuming a stale checkpoint** — a Cursor conversation only contains what Cursor itself produced. When the host's latest assistant turn in a session came from another model (another provider or a local model), the provider starts a fresh Cursor conversation seeded with the full host history, tool results included, rather than resuming the old checkpoint that would hide the other model's work (and has been observed to end Runs with `Cursor API error (code=internal)`). If that history would fill more than 80% of the target model's context, the provider reports a context overflow before opening a Run so the host compacts first.
- **Cursor-native CreatePlan writes a host plan file, and executing it always needs the user's approval** — when Cursor raises `create_plan_request_query`, the provider writes plain markdown where OpenCode itself keeps plans (never Cursor's `~/.cursor/plans`), with no Cursor YAML frontmatter: on OpenCode 1.x the session's `Session.plan` file (`<worktree>/.opencode/plans/<created>-<slug>.md` in a git project, else `<data>/plans/`); on OpenCode 2.0 its Plan directory (`~/.opencode/plan/`). A structural path bridge, when installed, supplies the host's own location instead. Writing never asks; executing always does, through the first channel the host offers: a host plan-stage tool runs its native review; under the host `plan` agent with `plan_exit`, CreatePlan runs that review and the session moving to the build agent is the approval; otherwise, in plan mode, the plan is shown in the transcript and the advertised `question` tool asks whether to switch to the build agent and start implementing (Yes switches and continues; anything else keeps planning). With none of these the plan is recorded and the user switches to the build agent when they want it implemented. Empty args still get the CLI empty-`plan_uri` success ack. Display `create_plan_tool_call` continues to mirror into `todowrite` separately.
- **Other Cursor-native interaction queries remain headless** — remaining UI/approval *queries* (as distinct from display tool calls and the AskQuestion / SwitchMode / CreatePlan / GenerateImage bridges) still cannot be surfaced through the AI SDK provider interface. The normal system prompt redirects available web capabilities to executable host tools (`custom_websearch`, `custom_webfetch`); native web/PR/MCP/SCM requests are declined so they remain behind host tool permissions. Compaction prompts are unchanged. Unknown future interaction variants fail the turn explicitly instead of hanging the Run stream.
- **Compaction resets Cursor conversation state without resetting stable workspace context** — the classic plugin marks OpenCode's `compaction` agent explicitly. On those turns the provider mints an isolated Cursor `conversation_id`, drops the prior checkpoint + KV blobs, preserves real tool outputs as OpenCode-host observations in the seed history, and re-advertises the session's last tool catalog while refusing execution during the summary itself. The first normal turn then rebases once more onto a fresh conversation seeded with OpenCode's compacted prompt and normal system instructions, so the summary-agent checkpoint cannot suppress later tool calls. Across both id rotations, the frozen workspace/rules/environment base and its prior encoded-context comparison seed are transferred instead of rebuilt; tools, skills, agents, plugins, and MCP state are still rediscovered, and the complete context is reused only when its bytes remain identical. Ordinary no-tool / `toolChoice:none` calls do not reset conversation state. Debug logs include system-prompt and encoded RequestContext hashes for cache-prefix verification.
- **Conversation bindings survive provider restarts** — after each successful `TurnEnded`, the OpenCode-session binding, latest checkpoint, checkpoint-reachable KV blob graph, frozen request-context base, last real tool catalog, host agent, stable system-prompt hash, and pending post-compaction rebase marker are atomically replaced in that session's private `<host-cache>/cursor-conversations/*.pb.gz` snapshot. The protobuf stores checkpoints, blob ids/data, and request context as bytes without JSON/base64 expansion, then gzip compresses the complete record. A checkpoint alone is insufficient: Cursor requests its referenced hashes through `get_blob` when the next Run starts. Reachability follows Cursor CLI's export traversal (turns, messages, steps, images, summaries, todos, prompts, and nested subagents), pruning superseded blobs; decode failure or a missing referenced hash conservatively retains the complete blob set. The stable OpenCode session id selects the file; Cursor conversation ids may rotate during compaction, agent switches, or prompt changes and remain inside the snapshot. Independent files prevent concurrent OpenCode processes from losing unrelated sessions by replacing a shared aggregate cache. Startup restores records updated within 24 hours and safely flushes older ones without deleting a concurrently published fresh replacement. Experimental legacy JSON snapshots are discarded rather than migrated. Debug logs report hydration as `restored`, `missing`, `invalid`, or `expired`, plus the compressed and protobuf snapshot sizes. The restored catalog is a fallback only for lifecycle turns such as compaction; an ordinary restricted/no-tool turn never resurrects it. Process-global bindings and prompt/catalog state still use a 256-session LRU bound; memory eviction drops the live checkpoint, blobs, and frozen context, which can be rehydrated from the restart cache on later use.
- **Oversized / incomplete checkpoint graphs warn but do not remint** — before reusing a checkpoint, the provider measures its reachable KV graph. State above 100 MiB (Cursor CLI export/transfer budget) or an incomplete graph is logged (`action=warm-reuse`) and the sticky conversation is kept, matching CLI soft-reuse. KV, request-context, MCP-state, interaction, and heartbeat writes are ordered per Run and await HTTP/2 drain, so a large blob reply cannot create an unbounded queue later misreported as heartbeat backpressure. Debug logs distinguish checkpoint-envelope bytes, reachable blob bytes, seed size, and encoded Run-request estimate; raw blob bytes are never presented as tokens.
- **Interrupted Runs resume from checkpoints** — a remote EOF, Connect end-stream, or trailer error is never emitted as a successful `stop`. When the failed Run produced an eligible checkpoint, the provider opens a new RPC for the same conversation and sends that state with `ResumeAction`, so completed text and tool work are not replayed. Before any stateful output, an interruption without a checkpoint can still rebase from OpenCode history. Stateful interruptions without a checkpoint are surfaced because replay would be ambiguous; retry exhaustion remains explicit. A transport closure after `turn_ended` is treated as successful completion.
- **Large reads are capped by OpenCode, and the cap is reported** — OpenCode 1.x `read` stops at `MAX_BYTES = 50 * 1024` and appends `(Output capped at 50 KB. Showing lines X-Y. Use offset=N to continue.)`. OpenCode 2 prints `Read file <path>, lines <start>-<end>` with `N: ` prefixes and, when the page ends before EOF, `[Output truncated. Continue reading with offset: N]` (50 KB or 2,000 lines); it also shortens each individual line after 2,000 characters. The provider strips either envelope before returning content to Cursor so the model cannot echo wrappers into a later write, but it re-states every partial result: a native read appends a `[Partial read: …]` marker after the content, an MCP read gets a separate notice content item, and a Pi read carries structured `PiReadExecSuccess.truncation`. Relative grep, glob, and directory entries are resolved against the workspace root. Shell stdout absolutizes only relative path tokens, not prose. Checkpointed turns, which do not resend the system prompt, get that same root on the user message. The structured `truncated` flag alone is not enough — verified against live `gpt-5.4-mini` and `grok-4.5` sessions, both of which asserted "highly confident" that partial content was the whole file until the textual marker was added. Deliberately paged reads (explicit `offset`/`limit`) are not marked unless the host also hits the byte cap or character-truncates a line. Whole-file writes and overwriting `Add File` patches that echo the marker are rejected before OpenCode executes them; targeted edits remain possible, including edits to source that quotes the warning text. Cursor's private legacy-edit read is handled separately as described above, so an edit can operate on a workspace file larger than 50 KB without turning the capped preview into a replacement. The cap is hardcoded in OpenCode's read tool — it is not the configurable `tool_output.max_bytes`, which governs `Truncate.Service` and not read's line accumulation — so ordinary model reads still require paging with `offset`.
- **No fallback models** — if Cursor’s `AvailableModels` API is unreachable and there is no local cache, the provider exposes no models.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for user-facing release notes. New work lands under `[Unreleased]` until the next version tag.

## License

MIT
