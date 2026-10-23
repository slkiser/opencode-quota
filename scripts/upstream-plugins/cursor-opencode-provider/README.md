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

You can also install from npm (`npm install cursor-opencode-provider` or `bun add cursor-opencode-provider`). Pin a version in host config if you want, for example `cursor-opencode-provider@0.8.2`.

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

After login, the plugin fetches your available models and writes them to `<host-cache>/cursor-models.json`. On later startups, a missing, empty, expired, or old-schema cache is refreshed during config load when Cursor auth is available; an existing stale cache remains usable if refresh fails. Completed conversation state is stored separately under `<host-cache>/cursor-conversations/`, with one independently replaced gzip-compressed protobuf snapshot per stable host session. Snapshots are refreshed at each successful Cursor `TurnEnded`, while a turn waits on a host tool, and when OpenCode 2 stops a turn or shuts down, and restored on demand after provider restarts. A session loads only its own snapshot; it never waits for a directory-wide cleanup. Records not updated for more than 24 hours are rejected on load and collected independently using bounded reads of their persisted metadata, without relying on filesystem modification times; the same age rule collects temp files left by an interrupted save. Full payload and gzip integrity checks run when a snapshot is restored. Cursor's checkpoint is an index of content-addressed KV blobs rather than a self-contained transcript, so the snapshot retains the blobs reachable from the latest checkpoint and discards superseded blobs. This private Cursor state is not a copy of the host's session database.

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

The selected variant’s Cursor parameter map is forwarded on the Run as `requested_model.parameters` (isolated under `providerOptions.cursor.cursorVariantParameters` so unrelated OpenCode options are not leaked onto the wire). The provider validates that explicit selection against the current cached tuple; malformed, duplicate-id, or stale selections fail clearly instead of silently falling back to another variant. Parameter order does not matter.

Without an explicit selection, an effort hint stays within the requested base or max tier and changes only the effort of that tier's default variant (thinking and other parameters keep the default's values). The provider prefers non-Fast variants within that tier and keeps Cursor's declared default effort when the default is Fast. An unavailable effort falls back to an advertised default tuple rather than inventing parameter values.

#### 1M / long context

OpenCode’s context limit is static per model entry, while Cursor’s long-context tier is a variant parameter (`context=1m`). When a model has both a base tier and a `1m` tier, the plugin emits a separate OpenCode entry `<model-id>-1m` (for example `claude-opus-4-8-1m`) with:

- `limit.context` set to the 1M window (so overflow checks and compaction match the tier)
- `limit.output` set to `128000` (max generation tokens — not the context window; base entries use `32000`)
- only the long-context variants in its picker
- the real Cursor model id carried in `options.cursorModelId` (not `config.id`, which would make OpenCode merge base variants into the 1M entry)

The Run still uses Cursor’s original model id; OpenCode’s synthetic `-1m` id is only for picking and limits.

Other advertised max-context tiers also get separate entries. For example,
Grok 4.7's marked 500k variants appear under `grok-4.7-500k`, with a 500,000-token
context limit; `grok-4.7-500k-fast` carries the Fast variants and pricing.
Each dedicated context entry keeps only its tier's variants and retains the declared default
effort, including when the default's non-Fast twin is needed. Non-1M entries
retain the base output limit of 32,000 tokens.

Existing non-1M variant names also remain on the original base/Fast entries so
saved selections such as `grok-4.7#Grok 4.7 High 500k` keep working after an
upgrade. These legacy selections send the selected 500k parameters and max-mode
flag, but keep the original entry's conservative static context budget. Select
`grok-4.7-500k` or `grok-4.7-500k-fast` to give OpenCode the full 500k budget.

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

OpenCode image file parts are decoded from bytes, base64/data URLs, local file URLs, or HTTP(S) URLs and sent through Cursor's `UserMessage.selected_context.selected_images` field. Fresh and rebased Runs normalize the same image formats as held-Run continuations, including AI SDK `image-data` / `image-url` and OpenCode attachment URLs. A Run that resumes a checkpoint skips the history images that exact checkpoint is known to hold (by content hash, recorded when a turn ends on a checkpoint of its own and kept in the restart snapshot); a Run without a checkpoint sends them all.

On a held-open Run, an image read returns bytes in `ReadSuccess.data` (including GenerateImage reference reads), and MCP tool images return as `McpImageContent` items after the success text (`McpToolResultContentItem` field 2). Detached media is attributed only where OpenCode's result order and markers establish its owner; ambiguous images stay available through history instead of being attached to an unrelated tool. A host instruction update beside a native read uses Cursor's context-injection channel because read text and bytes are mutually exclusive.

One 20 MiB decoded-byte budget covers all image-bearing pending results in a continuation, without Cursor CLI's resize/re-encode step. Unreadable or oversized tool images are reported without blocking other results; cancellation still stops decoding. Other result shapes have no image field, so their images reach Cursor as history on the next fresh Run. Direct PDF, audio, and video attachments are unsupported; tool-result delivery only forwards image media.

#### Max mode

Cursor IDE has a separate **Max Mode** toggle that sets `requested_model.max_mode` and selects the default max variant. OpenCode has no equivalent custom toggle, so this provider approximates it:

- Selecting a variant that Cursor's model list marks as max mode sets wire `max_mode` to `true`, as Cursor CLI does. That covers `*-1m` models and other max tiers such as Grok 4.7's 500k variants; a variant without the marker falls back to `context=1m`
- A model Cursor reports as not supporting non-max mode always runs in max mode
- An explicit `providerOptions.cursor.maxMode` hint without a picked variant also turns it on and selects the declared max default, using its non-Fast twin when available. A tier with only Fast variants remains selectable

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
  // cacheDir: "/path/to/host/cache", // optional; else path bridge or native OpenCode cache
  // retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 }, // optional stricter total limit
  // continuation: { heartbeatMs: 5_000, semanticIdleMs: 30_000, hardCapMs: 600_000 },
})

const model = cursor.languageModel("composer-2.5")
// model implements AI SDK LanguageModelV3 (doStream / doGenerate)
```

Give one credential source. The provider uses the first present and never falls back from one to another: `getAccessToken` (an async function returning the current access token, called for every Run so a long-running process can renew its login; it receives `{ forceRefresh: true }` once after Cursor rejects a token), then `accessToken` (a JWT sent as-is, never renewed), then `apiKey` (a raw `crsr_...` key, exchanged for a JWT and exchanged again near its expiry, the way Cursor CLI renews an API-key login). Optional: `apiBaseURL`, `agentBaseURL`, `cacheDir`, `headers`, `telemetryEnabled`, `retry`, and `continuation`. `cacheDir` pins the host cache root for model/version caches and Cursor project metadata; when omitted, the provider uses an injected structural host path bridge or the native OpenCode XDG cache described in [Paths](#paths-host-cache). An untouched checkpoint resume may renew a rejected credential once, while keeping completed tools behind the replay barrier. Follow-up Runs retain checkpoints received while opening. Transient failures resume from the latest checkpoint produced by that Run, matching Cursor CLI; without an eligible checkpoint, retries remain limited to replay-safe attempts so completed text or tool work is not duplicated. See [retry limits](#retry-limits) for the shared provider/host budget and endless retry option. Once that budget is spent, or replay is unsafe, the terminal error does not re-arm OpenCode's outer retry loop. Pending-tool inactivity is renewed by OpenCode activity from the session or its descendants. The older `baseURL` option is still accepted as a legacy alias for `agentBaseURL`.

### Shell results

A failed host shell call reaches Cursor once as stderr in streamed and unary
results. Distinct partial command output remains on stdout. See the
[1.x shell guide](docs/opencode-1.md#shell-failures-and-interruption) and
[2.0 tool guide](docs/opencode-2.md#feature-parity-vs-the-classic-plugin).

### Runtime folders

`agent-tools/` and `terminals/` live under the provider's per-workspace project
root in the host cache. The provider creates these private directories itself
and handles recognized catalog-spill writes and metadata reads directly on
Cursor's protocol. Directory creation, spills, and terminal polling do not
invoke OpenCode's workspace write/read tools or raise approval prompts. Only
the exact files `agent-tools/<uuid>.txt` and `terminals/<shell-id>.txt` are
handled this way; the folders themselves, other names in them, and paths that
resolve elsewhere go to OpenCode's own tools.
Workspace files, shell commands, generated image content, and plan execution
still use their existing host approval paths.

Explicit and soft-background shells keep a durable
`terminals/<shell-id>.txt` record containing status, output, command, cwd, PID,
timing, and the real exit code. Shell IDs are separate from PIDs. Output
reaches the record as the command writes it; the header is updated in place
every second, so a long-running command is never copied again. A soft-background
handoff returns the output of its foreground window, and a background notice
names the shell ID and its record. A detached supervisor owns the command
group, drains descendant output for up to five seconds after command exit, and
finalizes cancellations and hard timeouts, allowing the group three seconds
between TERM and KILL. If the supervisor itself dies (killed, crashed, or lost
to a reboot), the group is stopped and the record is reported as aborted with
an unknown exit status. Successful completion preserves deliberately detached
daemons, matching native OpenCode; cancellation, hard timeouts, and failed
commands stop their command group. The payload runs under the shell selected
by OpenCode, so bash and zsh syntax retains its native meaning.
A collector using the provider's JavaScript runtime
stores at most 8 MiB of command output and drains excess bytes without writing
them; the terminal header and completion footer are additional metadata.
Catalog spills are bounded to 8 MiB per file and 64 MiB / 128 files per project,
with at most one additional 8 MiB temporary file during atomic replacement;
reads to 1 MiB with an explicit partial-content notice. Records and job data
untouched for seven days are removed; a live supervisor refreshes its record
every second. Completed jobs discard auxiliary launch files immediately and
remaining job metadata after one minute; their terminal records stay readable.
Permission rejection and interrupted tools release unstarted reservations
without waiting for another model turn.
Cleanup runs during runtime operations as well as workspace discovery, at
most once a minute per project.
A terminal storage failure keeps captured output readable with an incompleteness
notice; a size-cap notice is added only when the returned content was capped. A spill storage failure returns an error instead of requesting
approval for a fallback write; folders removed from the cache are recreated.

A spawned background command is launched by a host command that contains the
command verbatim, so the host approval shows exactly what runs. A
soft-background command keeps its own text: the plugin's shell hooks run it
under the supervisor. On OpenCode 2, the shell create hook installs an
executable adapter while preserving the original command for permission
scanning; on classic bash/zsh the post-approval shell environment hook installs
the launcher. Other POSIX shells receive the complete inline launcher for
approval. A host without those hooks runs soft-background calls in the
foreground. The launcher's startup and foreground-window deadlines each run
on a single timer, so it reports within the host's own timeout; a spawn
reports its shell ID even when the command has already finished. A background
request made through OpenCode 2's own shell `background` option stays an
OpenCode background job with the host's completion notice. Supervision
requires POSIX bash or `setsid`. When this conversation has no usable terminal storage, the unmanaged `nohup`
fallback requires a POSIX shell. Native Windows PowerShell/`cmd` background
wrapping is unsupported; see [Known limitations](#known-limitations).
Transcript storage is supplied
separately through `CURSOR_AGENT_TRANSCRIPTS_FOLDER`; the provider neither
creates that directory nor writes host transcripts into it.

## Retry limits

Following Cursor CLI, each user turn allows **10 transport retries** and
**3 server retries**, counted separately. Connection failures and a stream ending
without `turn_ended` use the transport budget; server failures and the inbound
read-idle deadline use the server budget. Retries of the same turn share these
counts across checkpoints, tool steps and OpenCode's own retry calls. A new user
turn, successful completion or Stop starts a fresh budget. Counts are held in memory for the running process.
OpenCode 2's interruption notices keep the same budget as the original request,
including when a plugin appends recognized `<system-reminder>` or
`<system-update>` text parts. These notes remain in the request sent to Cursor;
attachments and ordinary follow-up text still identify a new request.
OpenCode may stop earlier under its own retry policy.

Like Cursor CLI, an active Run with no pending host work fails after **30 seconds
without an inbound frame**. Every inbound frame, including a heartbeat or partial
tool input, renews this deadline; client heartbeats do not. Silence uses the
transport retry budget and the 180-second consecutive-stall window. The separate
120-second transport read-idle watchdog remains a backstop. Direct SDK callers
can override `continuation.semanticIdleMs` (or its `softHealthMs` alias).

If a Run drops immediately after completed tool results, before new output,
the provider can rebuild from host history containing every observed exec's
result. It sends the completed results once and asks Cursor to continue. A
checkpoint predating those results is never resumed. Missing results, unknown
activity or a new interaction keep the failure final.
A checkpoint received while the completed result drains remains eligible.
History recovery retains completed results from earlier resumed Runs too.

For direct SDK use, `retry.maxAttempts` adds a total attempt ceiling, including
the initial attempt; omitting it uses the two Cursor CLI budgets. The existing
backoff defaults remain 500 ms full jitter, growing exponentially to an 8 s
ceiling (`baseDelayMs` / `maxDelayMs`). OpenCode controls delays when it owns
the retry after partial output. An unfinished tool display row, without an exec
or started tool lifecycle, also permits a host retry: the row closes as unfinished
and has no tool side effect to repeat.

Set `CURSOR_ENDLESS_RETRIES=1` or `true` before starting OpenCode (or its daemon)
to bypass both count limits and `retry.maxAttempts`, like Cursor CLI's endless
retry mode. This keeps retrying eligible transient failures; it preserves Stop,
final errors, authentication rules and tool replay guards. An upload with
uncertain delivery ends the turn even when an older checkpoint exists.
Cursor CLI's safety cutoffs remain: two resumed attempts that stream without a
new checkpoint end the turn, and consecutive semantic-stall retries stop once
180 seconds have elapsed since the first stall retry. A non-stall failure resets
that stall window. The setting does not override OpenCode's own retry limits.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CURSOR_WEBSITE_URL` | Override OAuth login base URL (default `https://cursor.com`) |
| `CURSOR_API_BASE_URL` | Override API base for auth, model discovery, and `GetServerConfig` agent URL resolution (default `https://api2.cursor.sh`) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Set to `1` or `true` to opt the `GetServerConfig` lookup into telemetry in OpenCode/plugin usage |
| `HTTPS_PROXY` / `https_proxy` | HTTP CONNECT proxy for HTTPS. Bun `fetch` uses this for unary RPCs; the Run HTTP/2 session also tunnels through it (see `NO_PROXY`). The Run tunnel supports only `http://` proxy URLs (Basic auth via userinfo); `https://` and SOCKS proxy URLs leave the Run on a direct connection. `HTTP_PROXY` is not used for HTTPS |
| `NO_PROXY` / `no_proxy` | Comma/space hosts that bypass the proxy (`*`, exact host, or `.suffix` / `suffix` domain forms; a `host:port` entry bypasses only that port) |
| `CURSOR_ENDLESS_RETRIES` | Set to `1` or `true` to bypass retry count limits; off by default. Safety cutoffs and host retry limits still apply. See [retry limits](#retry-limits). |
| `CURSOR_PROVIDER_DEBUG` | Set to `1` or `true` to enable wire-level debug logging |
| `CURSOR_PROVIDER_DEBUG_FILE` | Debug log path (default: `debug-<pid>.log` under `$TMPDIR/cursor-provider-logs-<uid>/`) |
| `CURSOR_AGENT_TRANSCRIPTS_FOLDER` | Optional folder containing past-chat transcripts, advertised to Cursor on OpenCode 1.x and 2.0. Sent only if it is an existing directory; unset, empty, missing, non-directory, or unstatable paths are omitted. Relative paths resolve against the workspace. The provider does not create the folder or write transcripts. |
| `CURSOR_OPENCODE2_DEV_ENTRY` | **Local OpenCode 2.0 only.** Absolute path to a built entry file (usually `dist/index.js`). Rewrites the AI SDK package to `aisdk:file://…` so the daemon imports your local build instead of `npm install`-ing the published package. Export it **before** `opencode2 service start`, then restart after rebuilds. Unset in production. See [OpenCode 2.0 local clone](docs/opencode-2.md#from-a-local-clone-cursor_opencode2_dev_entry). |
| `CURSOR_OPENCODE2_TODOS` | **OpenCode 2.0 only.** Set to `1` or `true` to register plugin-owned `todowrite`/`todoread` (in-memory; no TUI sidebar). Off by default. OpenCode 1.x still uses the host builtin. |
| `XDG_CACHE_HOME` | Base for native OpenCode cache (`$XDG_CACHE_HOME/opencode/`) when no explicit `cacheDir` or structural host path bridge is installed |
| `XDG_DATA_HOME` | When set, OpenCode `auth.json` is read from `$XDG_DATA_HOME/opencode/` instead of `~/.local/share/opencode/` |

Set `CURSOR_AGENT_TRANSCRIPTS_FOLDER` before starting OpenCode (or its daemon). The folder is checked when a conversation's RequestContext base is first built and stays frozen for that conversation; start a new session after changing the setting.

`createCursor({ agentBaseURL })` overrides the agent Run host. When unset, the provider resolves the host from Cursor's `GetServerConfig` API (`agentUrlConfig.agentnUrl`, region-specific — e.g. `agentn.us.api5.cursor.sh`, `agent-gcpp-uswest.api5.cursor.sh`) once per process and holds it in memory (never written to disk), so a held-open Run stream is never repointed mid-session. Explicit agent overrides and GetServerConfig results are validated as HTTPS `*.cursor.sh` hosts (Cursor's agent hostnames vary and may change); non-`cursor.sh` hosts are rejected. Shared HTTP/2 connections are rotated before they become server-aged, while existing Runs may finish on their original connection. The lookup sends `{ "telem_enabled": false }` by default; set `telemetryEnabled: true` in provider config, or `CURSOR_GET_SERVER_CONFIG_TELEMETRY=1` for OpenCode/plugin usage, to opt in. If the lookup fails or does not return a valid Cursor agent host, the model call fails clearly instead of falling back to `agentn.global.api5.cursor.sh`.

## Development

Changes listed under [Unreleased](CHANGELOG.md#unreleased) describe the development checkout; use a rebuilt local install to test them before a release. Maintainer guides and incident lessons are linked from the [documentation index](docs/README.md).

```bash
bun install          # install dependencies
bun run build        # compile TypeScript → dist/
bun run typecheck    # type-check without emit
bun test             # run unit tests
bun run test:node-http2 # Node HTTP/2 cleanup, drain, cancellation and memory regressions
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
| `src/protocol/conversation-persistence.ts` | Atomic per-session restart snapshots, on-demand hydration and independent 24-hour cache maintenance |
| `src/protocol/conversation-cache-header.ts` | Bounded streaming inspection of persisted snapshot metadata without decoding checkpoint/blob payloads |
| `src/context/paths.ts` | Host cache root + Cursor project metadata under `<host-cache>/projects/<slug>/` |
| `src/agent-url.ts` | `GetServerConfig` fetch + in-process memo (region-specific Run host) |
| `src/transport/connect.ts` | HTTP/2 bidi stream and unary RPC calls |
| `src/transport/https-proxy.ts` | `HTTPS_PROXY` / `NO_PROXY` CONNECT tunnel for Run sessions |
| `src/protocol/` | Protobuf encode/decode, checksum/device ids, exec + display tool-call mapping (`tool-call-bridge.ts`) |

### Injected system guidance

The provider adds OpenCode-specific system guidance to normal tool-capable conversations, including tool availability, canonical workspace-path grounding, preferring OpenCode `todowrite` / `todoread` over Cursor TodoWrite when those tools are advertised without inviting catalog-comparison narration, and preferring `edit` / `write` (or the advertised patch tool: `apply_patch` on OpenCode 1.x, `patch` on OpenCode 2.0) over shell-based file mutation when those tools are available. Compaction keeps its dedicated prompt unchanged.

Cursor keeps OpenCode `skill` and configured MCP tools off its native top-level function list on **both** OpenCode 1.x and OpenCode 2.0 — they appear as names-only MCP descriptors and are reached through GetDynamicTools / CallDynamicTool (exec #36 supplies full definitions). When the host advertises `skill` and/or tools of MCP servers configured in `opencode.json`, the provider names those routes in system guidance and mirrors OpenCode's load-when-matches / do-not-reinvoke rules so models prefer `skill` / MCP over Grep/Shell and do not narrate that those tools are unavailable. When the host advertises `skill`, skills that have a usable file path are also listed in RequestContext `agent_skills` (path and description only), as Cursor's own clients list them. Skill catalog changes after admission are host `<system-update>` notes; `agent_skills` follows the baseline catalog until the next epoch. OpenCode 2 still moves MCP servers that did not set `"codemode": true` onto the direct AI SDK catalog first; without that placement they never reach Cursor's MCP ads at all (see [OpenCode 2 MCP tools](docs/opencode-2.md#mcp-tools)).

Each discovered dynamic definition carries its exact `namespace` and `toolName` in its description. Keep those fields at the outer level of every `CallDynamicTool` call; the discovered input schema describes only its `arguments` object.

Native Cursor todo display updates (`update_todos_tool_call` / `read_todos_tool_call`) are mirrored into `todowrite` / `todoread` when those host tools are advertised. OpenCode 2 dropped the host builtins; set `CURSOR_OPENCODE2_TODOS=1` (or `true`) to register the same canonical names when the catalog omits them (in-memory per session, cleared on `session.deleted` and process restart). With the flag unset, the plugin registers no todo tools. Enabled plugin tools are **direct** catalog tools (`options.codemode: false` plus an `output` schema), not Code Mode helpers. The provider retains the last known full list per OpenCode session — refreshed by bridged writes, direct host `todowrite` calls, and `todoread` results, surviving Run close, checkpoint resume, and later turns — so `merge: true` updates that omit Cursor's completed list still become a host replace-all snapshot (matched by id, then by content across id spaces). This snapshot is in-memory only and never enters the prompt, RequestContext, or persisted restart state, so Cursor's prompt-cache prefix is unaffected; a provider process restart clears it until the next write/read (intentional — see [todo lessons](tasks/lessons/opencode.md#boundaries-and-tool-contracts)).

If this guidance causes issues, update `buildOpenCodeInteractionGuidance` in [`src/language-model.ts`](src/language-model.ts) and its focused coverage in [`test/prompt-history.test.ts`](test/prompt-history.test.ts).

### Cursor edit handshakes

Cursor's legacy `edit_tool_call` is implemented internally as a correlated `read_args` followed by a whole-file `write_args`; the write is transport mechanics, not a new decision to replace OpenCode's `edit` tool. For regular files inside the workspace, the provider answers that private prerequisite read directly with the complete file (up to Cursor's own 50 MB edit limit), because routing it through OpenCode's ordinary 50 KB-capped `read` tool makes Cursor calculate a truncated replacement. This shortcut is restricted to the exact path named by the active edit call and rejects symlink escapes. External paths first take OpenCode's permission-aware read path; after that exact read succeeds, the provider upgrades its private result to complete content so an explicitly authorized external edit does not inherit OpenCode's preview cap.

The provider retains the correlation and exposes the resulting existing-file mutation as one unique, line-bounded OpenCode `edit`, including turns that permit `edit` but withhold `write`. It still returns Cursor's expected typed `write_result`. When only a patch tool is permitted, that targeted edit becomes an `*** Update File:` patch. New-file creation uses `write` when permitted, otherwise the permitted patch tool's `*** Add File:` operation.

Ordinary complete native reads also preserve an existing final LF/CRLF. OpenCode's numbered read envelope cannot represent that terminator, and dropping it made exact edit matching fail. This restoration applies only to confirmed-complete, unbounded reads; paged and capped reads keep their existing truncation behavior.

### `apply_patch` / `patch` on GPT models

OpenCode selects the file-editing tools before calling this provider:

| Host | Patch tool | Input |
|------|------------|-------|
| OpenCode 1.x | `apply_patch` | `{ patchText }` |
| OpenCode 2.0 | `patch` | `{ patchText }` |

Both hosts replace `edit` / `write` with their patch tool when the API model id contains `gpt-`, excluding ids containing `oss` or `gpt-4`. Other models normally keep `edit` / `write`. This is host behavior; the provider selects its translation from the current turn's permitted tools, including after a model switch, without branching on a model id or host version.

The host's patch tool is advertised to Cursor through the dynamic tool catalog and can be called directly. Cursor also sends native write/edit exec requests, which the provider converts before checking tool availability when the corresponding `write` or `edit` tool is absent:

- An uncorrelated text write becomes `*** Add File:`, which can create a file or intentionally overwrite its complete contents.
- A correlated legacy edit or native substring edit becomes a targeted `*** Update File:` patch.
- If the requested native tool is permitted, it remains `write` or `edit`; if neither it nor a patch tool is permitted, the request is refused.

Blank lines and representable line endings are preserved. Conversions that cannot preserve the requested operation return a specific error before a host mutation is emitted. These include paths containing newlines or trimmed whitespace, unreadable or ambiguous edits, and nonempty resulting content without a final newline.

On 1.x, translated edits normalize their old/new text to the existing file's LF/CRLF convention, matching native `edit` even when Cursor sends an LF-only correlated write. Direct `apply_patch` updates also restore CRLF in context and added lines. Direct updates of mixed-ending or unterminated files are refused when their bytes cannot be safely preserved; use a Cursor-native targeted edit for mixed-ending files. Intentional whole-file writes and `*** Add File:` payloads keep the requested line endings.

OpenCode 2's `patch` parser strips CRLF carriage returns, so both native conversions and direct `patch` calls that would lose them are refused; the provider leaves the file unchanged. This restriction belongs to the patch path, not to native `edit` / `write` when those tools are permitted. See [`src/protocol/apply-patch.ts`](src/protocol/apply-patch.ts) for host-source references and [`remapEditToolsForCatalog`](src/protocol/tools.ts) for the translation.

### Native subagent routing

The provider reads the permission-filtered subagent catalog from the current host `task` or `subagent` definition and advertises those recipients to Cursor as custom subagents. Native Cursor Task exec remaps onto `task` when advertised, otherwise onto OpenCode 2 `subagent` (`agent` / `sessionID` / `background`). Exact configured names are preserved; unknown future Cursor subtype strings fall back to `general`. If a complete catalog omits every compatible recipient, the request fails on Cursor's typed subagent channel instead of selecting an arbitrary specialist.

When Cursor's Task attaches files, Cursor first reads each one and would hand the bytes only to its own subagent context, which OpenCode's subagent tools cannot take. For reads matching that Task's attachment list, the provider checks the target and returns placeholder image bytes without reading its content, including for runtime metadata attachments. Missing, invalid or unstatable targets receive typed failures. The child prompt lists absolute paths as JSON strings, preserving filename spaces and escaping line breaks; the child opens them with its own permission-checked tools. The parent gets no extra attachment-read step, and the host call retains Cursor's description. Image inspection requires an image-capable model in the child; a placeholder does not enable vision on a text-only model.

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
| `cursor-opencode-provider/models` | Model discovery and cache APIs |
| `cursor-opencode-provider/pricing` | Pricing and capability lookup APIs |
| `cursor-opencode-provider/auth` | Authentication APIs |
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
| Stream hangs or HTTP/2 errors | The provider keeps Cursor's Run open across OpenCode tool calls, rotates aged shared connections, resumes transient interruptions from the latest eligible Cursor checkpoint, and falls back to a fresh-history rebase only before stateful output when no checkpoint exists. A transient interruption after only text or reasoning, without a checkpoint from that turn, is left to OpenCode to retry. Completed tools remain replay barriers across host steps; credential renewal retains the latest eligible checkpoint. Repeated resumes without progress end as an error. Behind an HTTP proxy, set `HTTPS_PROXY` (and `NO_PROXY` as needed): unary `fetch` and the Run HTTP/2 CONNECT tunnel both honor them. With debug logging enabled, look for `Run interrupted`, `resuming … checkpoint`, `rebasing fresh Run`, or `h2 connect via HTTPS proxy`. Restart OpenCode after rebuilding a local `file://` install. |
| No response / silent 200 + close | HTTP 200 alone is not a successful agent turn: the provider now requires Cursor's explicit `turn_ended`, captures HTTP/2 trailers/GOAWAY, and retries bare EOF within the transport retry budget. The Run host still comes from in-memory `GetServerConfig` resolution; set `CURSOR_PROVIDER_DEBUG=1` to confirm the host and termination reason. |
| Visible `<shell_metadata>` timeout text | Rebuild and restart a local install. Cursor's shell timeout is carried on its exec request; the provider now removes OpenCode's internal timeout envelope before it is rendered or stored, then returns Cursor's typed timeout or background-handoff event instead of treating the text as successful stdout. |
| `Unsupported Cursor exec variant …` | The error names the canonical Cursor CLI request field, its expected result field, and this provider's handling classification. Known `handling=unsupported` variants (Cursor-native capabilities without a safe OpenCode AI SDK bridge) are now soft-denied on the wire with a populated typed error/`rejected`/`allowlisted:false` result and the Run continues — look for `exec: SOFT-DENIED …` in the debug log and a `Workspace root: …` suffix in the deny text — while `unknown request field` still hard-fails as protocol drift; `handling=opencode-tool` or `provider-control` indicates a provider decoder/dispatch regression. Enable the debug log and report the full named error. |
| Need wire-level logs | Set `CURSOR_PROVIDER_DEBUG=1` (optional `CURSOR_PROVIDER_DEBUG_FILE`; the default is `debug-<pid>.log` under `$TMPDIR/cursor-provider-logs-<uid>/`) and reproduce the issue. Every completed turn emits a `turn usage validation: status=ok\|mismatch` line confirming token-accounting integrity and a `cache diagnosis:` line showing warm/cold checkpoint continuity, raw read/write/uncached tokens, cache-read coverage of the prior context, context/category deltas, stable RequestContext hashes, and Run step/tool counts. Checkpoint lines include Cursor's current category totals. Cursor does not expose per-model-call cache splits, so the diagnostic labels that value unavailable instead of inferring it from aggregate `TurnEnded` counters. |
| OpenCode token totals stay stuck until the turn ends | OpenCode TUI/GUI display the last assistant message with non-zero output, they do not sum occupancy. Tool-call steps emit Cursor's last-known checkpoint occupancy (with `output > 0` so the footer accepts it), billed as an estimate of one model call. At `TurnEnded` the session cost is reconciled toward the aggregate counters at catalog rates, within the limits below. If a checkpoint has not arrived yet, the previous turn's occupancy stays visible as stale. With no known snapshot, usage stays zero instead of mislabeling estimates or `TurnEnded` as context. Raw request counters remain in `providerMetadata.cursor`. |
| Context percentage jumps after a long tool turn or compaction | Cursor reports its authoritative context snapshot in checkpoint `token_details`. The provider makes AI SDK input + output equal `usedTokens`, shapes the input/cache partition for cost reporting, and exposes `maxTokens`, percentage, and category breakdown under `providerMetadata.cursor.context`. Mid-turn tool steps publish that occupancy with an estimated cost; compaction naturally replaces the prior snapshot with Cursor's smaller total. |
| Cache **write** tokens differ from Cursor’s raw counters | Standard input/cache counters are shaped for host cost reporting and may include synthetic cache-write tokens. Exact request counters remain in `providerMetadata.cursor.*Raw`. Captured Runs can report `cache_write=0`; this does not imply that the synthetic host split is a measured cache split. |

## Security

Project `instructions` may reference absolute or `~/` paths (OpenCode parity). See [SECURITY.md](./SECURITY.md) for the trust model and `OPENCODE_DISABLE_PROJECT_CONFIG`.

## Known limitations

- **Native planning calls and handoffs** — CreatePlan and SwitchMode use their already supplied native function definitions, never dynamic discovery or CallDynamicTool. Where an approved switch resumes in the host's plan agent after the current turn, that turn ends before any further tool call; the following plan turn records the plan. Debug logs include server-side native discovery errors as well as MCP invocation errors, without replaying either as host execution.
- **Personal use / ToS** — this provider speaks Cursor’s private agent protocol (CLI-shaped client identity). Use only with an account you own; Cursor may change or restrict the API without notice.
- **Cursor's checkpoint controls displayed totals** — AI SDK input + output equal the latest checkpoint's `used_tokens`. Tool boundaries and the final finish use `output=1`, `reasoning=0`, and the remaining occupancy as input/cache, so OpenCode's footer updates without treating whole-Run generation counters as per-step speed. The input/cache split is synthetic for cost reporting; exact aggregate request counters remain under `providerMetadata.cursor.*Raw`. A retained previous checkpoint is marked `source: "checkpoint-previous-turn", stale: true`; without any snapshot standard usage stays zero and context metadata is absent. Compaction replaces occupancy with the smaller checkpoint total.
- **Cost reporting has bounded settlement** — tool steps estimate one model call from occupancy and the previous step's cached prefix. A final `TurnEnded` replaces that Run's estimates with its aggregate counters priced at published catalog rates, then shapes the final step toward the outstanding balance. If the Run closes before those counters arrive, its charges remain unconfirmed estimates (`sessionEstimatedUsd`) and never become credits against later Runs. OpenCode 2 prices that split; OpenCode 1.x receives the same amount in `providerMetadata.copilot.totalNanoAiu`. Whole-token rounding, a positive minimum price, and the snapshot's maximum price can prevent exact settlement. Negative balances cannot refund earlier charges; positive or negative remainders carry to later priced turn-ends and may persist. Missing occupancy or unpublished rates (Auto) bill zero and cannot settle an earlier remainder. The ledger is shared by package copies in one process, holds at most 1,024 recently written sessions, and resets on process restart. User-configured host rate overrides are not visible to the provider. This is catalog-priced accounting, not a Cursor invoice: aggregate counters do not expose per-call prompt sizes or tier choices, so internal compaction or calls crossing pricing tiers cannot be priced exactly. The tier estimate uses final context capped at aggregate input, so output alone cannot select a higher input tier.
- **`request_context` from OpenCode** — each Run sends Cursor `RequestContext` with OpenCode's system prompt (its `AGENTS.md` / `instructions`, skill list, MCP instructions) plus the provider's interaction guidance as one always-apply rule, workspace env, git, layout, host-advertised `task`/`subagent` names, names-only tool overlay, and plugin lines. Cursor does not follow a client-seeded `system` message or an untyped rule, so the always-apply (`global`) rule is the channel that makes `AGENTS.md` effective; the provider does not read instruction or skill files itself. Merged `opencode.json` is still read for MCP server ids, plugin lists, and interaction guidance. Expensive workspace state (environment, repository, git, and layout) is frozen per Cursor conversation and persisted for restart recovery. Tools/MCP names, host subagents, and plugin metadata are rediscovered each Run then epoch-held (equal ids keep frozen bytes; new ids append); unchanged overlays reuse byte-identical encoded context. Concurrent first Runs share one base build. Compaction transfers the stable workspace base to the new conversation and refreshes its capability overlay. Its canonical root is also used by the [injected system guidance](#injected-system-guidance). Cursor-only cloud/sandbox marketplace surfaces are omitted. `env.workspace_paths` / `process_working_directory` stay on the real git workspace; Cursor's metadata root (`project_folder`, MCP `workspace_project_dir`, and managed runtime folders) is advertised under `<host-cache>/projects/<slug>/` (using OpenCode's native cache directory by default) so dumps like `agent-tools/` do not land in the repo. OpenCode remains the permission authority: its coarse allow/ask/deny configuration is not fabricated into Cursor's unrelated allow/block instruction-list messages.
- **Configured MCP tools keep their upstream server id** — OpenCode builtins and plugin/custom tools are advertised under a synthetic `opencode` MCP server. Tools whose flattened name matches an MCP server in merged `opencode.json` configuration (`github_create_pull_request`, …) are grouped under that server's `provider_identifier` in the dynamic catalog (`github`, …). Unknown underscore-containing names stay under `opencode` rather than being guessed incorrectly. Cursor's MCP-state exec probe is answered from the same advertised descriptors before the actual tool request, using the full canonical tool-definition identity required by native `get_mcp_tools` / GetDynamicTools; exec still reconstructs the full OpenCode tool id. That discovery call is Cursor-native (not an OpenCode catalog tool). Oversized catalogs spill through `write_args` into `agent-tools/<uuid>.txt`; `WriteSuccess.path` echoes the requested path so the model receives a real `filePath` instead of an empty spill.
- **Display completions are notifications, not execution requests** — Cursor `tool_call_*` frames use a typed `ToolCall` oneof. The provider decodes them for diagnostics but only mirrors finalized todo/plan state (`update_todos_tool_call` → `todowrite`, `read_todos_tool_call` → `todoread`, `create_plan_tool_call` → `todowrite`); the completed payload already contains the authoritative final list. Interactive, data-returning, and side-effecting completions are never replayed as new tools because their result could not be returned to Cursor. Exec-backed native subagent/Task and Pi read/bash/edit/write/grep/find/ls calls use their typed request/result fields instead. Unknown display variants are logged. Cursor CLI exec request/result pairs are inventoried by field and name in [`src/protocol/exec-variants.ts`](src/protocol/exec-variants.ts). Known-but-unsupported variants are soft-denied on the held Run with a populated typed error/`rejected`/`allowlisted:false` result (or `throw` when the CLI has no typed error shape) so the turn continues; unknown future request fields still fail the Run explicitly rather than receiving a guessed response that could deadlock it.
- **Progress-only fragments can get one continuation** — if a real tool-enabled turn ends with a short progress fragment ("Checking the workspace", "Looking into it now") and no host tool call, the provider opens one follow-up Run with a synthetic user nudge so the model can call a listed tool or finish the answer. Complete answers that merely start with those verbs are not continued. Title/compaction turns (`allowTools=false`) never continue. If the continuation fails, the original `turn_ended` is still reported as a successful stop.
- **Tool availability is per OpenCode agent** — Cursor can request native capabilities such as Task even when a child or restricted OpenCode agent did not advertise the corresponding host tool. The provider prompts Cursor with the exact current catalog and checks every decoded host-tool exec request against it. An unavailable request is answered on Cursor's correlated typed result channel and is never emitted as OpenCode's `invalid` tool.
- **Host web tools use collision-safe aliases** — Cursor sees `custom_websearch` / `custom_webfetch`, and the held Run maps each alias back to an executable OpenCode tool with its schema, permission check, and correlated result intact. OpenCode 2 ships `websearch` as a direct, permission-gated catalog tool; this plugin supplies it an Exa provider through `ctx.websearch.transform` and aliases the host tool for Cursor. It does not add a second direct fallback because OpenCode 2's public plugin tool context cannot raise the host permission prompt. Classic 1.x still registers `custom_websearch` through its permission-aware tool API to avoid OpenCode's reserved `websearch` id filter. Exact host `webfetch` is translated the same way. Cursor's UI-bound native web interactions stay disabled because their approval replies cannot carry OpenCode tool results.
- **MCP resource tools (`list_mcp_resources` / `read_mcp_resource`) also use collision-safe aliases, and Cursor's native resource exec is always answered** — OpenCode's resource tools (advertised only when a connected MCP server declares `capabilities.resources`) share bare names with two of Cursor's own native tool-call variants. Left unaliased, Cursor's client can route a call onto its native exec channel instead of the ordinary MCP tool path, which this provider does not translate — confirmed live: reading a resource was dispatched natively and killed the Run before this fix. The provider now aliases both names to `custom_list_mcp_resources` / `custom_read_mcp_resource` (same mechanism as web search/fetch) so normal calls execute through OpenCode's tools, and separately answers Cursor's native resource-exec fields directly on the protocol floor — an empty list, or a "server not found" error for read — so an unsolicited native request from Cursor can never fail the Run. Downloads (`download_path`) have no OpenCode equivalent and are always refused; binary resource content is subject to the same [50 KB / attachment-type limits](#known-limitations) as other tool results.
- **Background shells are non-interactive** — Cursor's native background-shell spawn and soft-background shell-stream timeouts are bridged through the advertised OS shell (`bash` on 1.x, `shell` on 2.0). Native OpenCode 2 `background` calls keep the host's own job ownership and completion notices. With bash/zsh, the classic plugin keeps the original permission/UI command and executes the wrapper through `shell.env` (`BASH_ENV` / `ZDOTDIR`); OpenCode's non-interactive sh/dash argv ignores those startup variables, so the plugin uses a short `exec /bin/sh '<wrapper-file>'` command backed by the same private wrapper. Native background-spawn requests also carry a self-contained marker-producing fallback when the classic hooks are absent. Managed spawn/soft-background runners detach with `nohup`, write `terminals/<shell-id>.txt` under the pinned provider project root, and return a separate shell ID and supervisor PID (or typed timeout/exit) to Cursor; without managed storage the POSIX wrappers redirect output under `${TMPDIR:-/tmp}/cursor-opencode-{bg,shell}.*` and return the command's PID. Native polling and canonical metadata reads are answered directly by the provider. Private markers and OpenCode's `<shell_metadata>` envelope are stripped before storage/render, with a short still-running / started / timed-out status line left for the bash bubble. Requests that require `write_shell_stdin` are rejected explicitly because OpenCode does not expose an interactive background-process lifecycle through its AI SDK tool interface. The POSIX wrap path is not implemented for native Windows PowerShell/`cmd`.
- **Cursor-native AskQuestion reaches you through OpenCode's question tool** — when Cursor asks a clarifying question, the provider translates the interaction into the host `question` tool, so the prompt appears in OpenCode with its real options and your answer is mapped back to Cursor's option ids (an answer you type yourself becomes Cursor's freeform text). Questions Cursor marks as non-blocking are acknowledged immediately and answered later, matching Cursor CLI. If the current agent does not offer `question` — most subagents deny it, and compaction turns have no tools — the request is declined with that reason and the model asks in its reply instead.
- **Cursor-native SwitchMode follows each OpenCode generation's planning model** — on OpenCode 1.x, advertised `plan_enter` / `plan_exit` tools remain authoritative and Cursor waits for their approve/reject result. OpenCode 1.x without `plan_enter` (current releases advertise only `plan_exit`, behind `OPENCODE_EXPERIMENTAL_PLAN_MODE`) is switched into its own `plan` primary agent once the owning Run ends, through a synthetic `session.promptAsync` turn for that agent (only for sessions running one of the primary agents read from `app.agents()`); a CreatePlan raised before that switch is deferred to the plan-agent turn. Inside the `plan` agent, CreatePlan writes the plan to the session's plan file (OpenCode's `Session.plan` location, or the structural path bridge's `planFile`) and runs the `plan_exit` review; OpenCode moving the session to its build agent is the approval. Cursor's own mode follows the OpenCode agent on every turn (`UserMessage.mode`, as Cursor CLI sends it): choosing `plan` in the agent picker puts Cursor in plan mode, and leaving it ends Cursor plan mode. OpenCode 2.0 replaced those tools with vendor-maintained primary `plan` / `build` agents, so its plugin applies an approved Cursor mode change through `session.switchAgent` after the owning Run is terminal; without a `plan_exit` tool, the plan is approved through CreatePlan's `question` prompt (below), and a Cursor SwitchMode out of the host `plan` agent is pointed there. Direct host UI agent switches are also observed. Host-agent and system-prompt changes keep the sticky Cursor conversation and frozen baseline; changed instructions arrive chronologically on the next user turn. Title/generation lifecycle prompts remain ephemeral and do not evict the primary cache. Provider-owned Cursor reminders remain the fallback when a host cannot switch agents.
- **Cursor image generation saves through OpenCode's permission where the host API exposes it** — Cursor generates the image on its servers and then writes it like any other file. The provider holds raw bytes and commits them through handle-only `cursor_image_save`. On the classic plugin/OCP surfaces it asks for the same permissions as a normal write (`external_directory`, then `edit`) before saving byte-for-byte. OpenCode 2.0's public plugin `ToolContext` has no permission-request method, so that entrypoint still advertises the tool with catalog `permission: "edit"` and writes after containment. By default images land in the Cursor project folder under `assets/`, kept out of the git tree as agent artifacts. GenerateImage `reference_image_paths` use the same held-Run `ReadSuccess.data` path as an ordinary image `read` (no CLI resize; large refs may still hit the 20 MiB decode budget). The classic implementation is adapted from [`jkalasas/opencode-antigravity-image`](https://github.com/jkalasas/opencode-antigravity-image) (MIT) by jkalasas.
- **Returning after another provider answered reseeds foreign history** — a Cursor conversation only contains what Cursor itself produced. When the host's latest assistant turn in a session came from another provider or a local model, the provider starts a fresh Cursor conversation seeded with the full host history, tool results included, rather than resuming the old checkpoint that would hide the other model's work (and has been observed to end Runs with `Cursor API error (code=internal)`). If that history would fill more than 80% of the target model's context, the provider reports a context overflow before opening a Run so the host compacts first. Switching directly between Cursor models keeps the same conversation and checkpoint.
- **Cursor-native CreatePlan writes a host plan file, and executing it always needs the user's approval** — when Cursor raises `create_plan_request_query`, the provider writes plain markdown where OpenCode itself keeps plans (never Cursor's `~/.cursor/plans`), with no Cursor YAML frontmatter: on OpenCode 1.x the session's `Session.plan` file (`<worktree>/.opencode/plans/<created>-<slug>.md` in a git project, else `<data>/plans/`); on OpenCode 2.0 its Plan directory (`~/.opencode/plan/`). A structural path bridge, when installed, supplies the host's own location instead. Writing never asks; executing always does, through the first channel the host offers: a host plan-stage tool runs its native review; under the host `plan` agent with `plan_exit`, CreatePlan runs that review and the session moving to the build agent is the approval; otherwise, in plan mode, the plan is shown in the transcript and the advertised `question` tool asks whether to switch to the build agent and start implementing (Yes switches and continues; anything else keeps planning). With none of these the plan is recorded and the user switches to the build agent when they want it implemented. Empty args still get the CLI empty-`plan_uri` success ack. Display `create_plan_tool_call` continues to mirror into `todowrite` separately.
- **Other Cursor-native interaction queries remain headless** — remaining UI/approval *queries* (as distinct from display tool calls and the AskQuestion / SwitchMode / CreatePlan / GenerateImage bridges) still cannot be surfaced through the AI SDK provider interface. The normal system prompt redirects available web capabilities to executable host tools (`custom_websearch`, `custom_webfetch`); native web/PR/MCP/SCM requests are declined so they remain behind host tool permissions. Compaction prompts are unchanged. Unknown future interaction variants fail the turn explicitly instead of hanging the Run stream.
- **Compaction resets Cursor conversation state without resetting stable workspace context** — the classic plugin marks OpenCode's `compaction` agent explicitly. On those turns the provider mints an isolated Cursor `conversation_id`, drops the prior checkpoint + KV blobs, preserves real tool outputs as OpenCode-host observations in the seed history, and refuses execution during the summary itself. A host-empty catalog stays empty (including classic compaction); OpenCode 2 compaction can carry a nonempty catalog, whose epoch advertisement is retained. The first normal turn then rebases once more onto a fresh conversation seeded with OpenCode's compacted prompt and normal system instructions, so the summary-agent checkpoint cannot suppress later tool calls. Across both id rotations, the stable workspace base and prior encoded-context comparison seed transfer. Each new epoch admits its own system-instructions baseline; tools, skills, agents, plugins, and MCP state are still rediscovered, and the complete context is reused only when its bytes remain identical. Ordinary no-tool / `toolChoice:none` calls do not reset conversation state. Debug logs include system-prompt and encoded RequestContext hashes for cache-prefix verification.
- **Conversation bindings survive provider restarts** — after each successful `TurnEnded`, the OpenCode-session binding, latest checkpoint, checkpoint-reachable KV blob graph, frozen request-context base, last real tool catalog, host agent, stable system-prompt hash, pending post-compaction rebase marker, deferred host notes, turn provenance, and early-steer receipts are atomically replaced in that session's private `<host-cache>/cursor-conversations/*.pb.gz` snapshot. The protobuf stores checkpoints, blob ids/data, and request context as bytes without JSON/base64 expansion, then gzip compresses the complete record. A checkpoint alone is insufficient: Cursor requests its referenced hashes through `get_blob` when the next Run starts. Reachability follows Cursor CLI's export traversal (turns, messages, steps, images, summaries, todos, prompts, and nested subagents), pruning superseded blobs; decode failure or a missing referenced hash conservatively retains the complete blob set. The stable OpenCode session id selects the file; Cursor conversation ids may rotate during compaction or a recovery/history rebase and remain inside the snapshot; agent and prompt changes alone do not rotate them. Independent files prevent concurrent OpenCode processes from losing unrelated sessions by replacing a shared aggregate cache. On-demand hydration accepts records updated within 24 hours; independent maintenance reads only bounded metadata prefixes and preserves concurrently published replacement files. Payload/checksum validation runs on restoration, and filesystem modification times never determine retention. Experimental legacy JSON snapshots are discarded rather than migrated. Debug logs report hydration as `restored`, `missing`, `invalid`, or `expired`, plus the compressed and protobuf snapshot sizes. The restored catalog can retain epoch advertisement, but never grants execution permission: each turn uses its own permitted set, and a host-empty call still advertises `[]`. The recent-session binding index uses a 256-session LRU bound; eviction removes its lookup pointer while retaining checkpoint, blob, and frozen-context state for warm reuse.
- **Oversized / incomplete checkpoint graphs warn but do not remint** — before reusing a checkpoint, the provider measures its reachable KV graph. State above 100 MiB (Cursor CLI export/transfer budget) or an incomplete graph is logged (`action=warm-reuse`) and the sticky conversation is kept, matching CLI soft-reuse. KV, request-context, MCP-state, interaction, and heartbeat writes are ordered per Run and await HTTP/2 drain, so a large blob reply cannot create an unbounded queue later misreported as heartbeat backpressure. Uploads have no fixed drain deadline; stream termination and the read-idle watchdog bound failed connections. Stopping a turn cancels its initial, tool-result, or replacement upload, while the normal abort after a tool step keeps that Run open for its results. Debug logs distinguish checkpoint-envelope bytes, reachable blob bytes, seed size, and encoded Run-request estimate; raw blob bytes are never presented as tokens.
- **Edit rows can appear before the call is complete** — an announced edit opens a host tool row while Cursor streams its arguments. The eventual exec binds that row; if no call arrives, the provider closes it without asking the host to execute incomplete arguments ([early rows](src/early-tool-rows.ts)). An edit whose file read must first go through OpenCode's `read` (a file outside the workspace, or one the provider cannot read) opens no early row: that read is the call's first exec and would close the row as a failed edit. When the call runs as a host tool the row did not predict (a rewrite with unchanged content stays a `write`), the row completes with a note naming that call; OpenCode 2 does not allow a started row to change its tool name.
- **Large uploads share a connection without the default 10 MB bottleneck** — direct and proxied Run connections use a 256 MB session-memory limit. This prevents queued sibling requests, or one large Node upload on a slow uplink, from triggering the default `NGHTTP2_ENHANCE_YOUR_CALM` refusal. The limit remains finite. Cached connections hold the process alive only while a Run or health-check ping is active, so an idle connection does not prevent a headless process from exiting ([transport](src/transport/connect.ts)).
- **A quiet model or a running tool is still active** — every inbound frame, including heartbeats while a model composes tool arguments, renews Run liveness. Pending host execs receive client heartbeats; while tools run, the provider continues answering Cursor's KV requests and exec aborts. Open permission/question prompts and active descendant tools renew held Runs; a running tool can extend its lease up to four hours from its own start ([Run reader and heartbeats](src/language-model.ts), [leases](src/session.ts), [activity](src/activity.ts)).
- **Requests not yet checkpointed survive failed turns** — the next turn on the same checkpoint carries the missing request, including after a restart. Repeated retries do not stack copies of the same interruption note. A newer checkpoint, host Stop or rebuild from host history clears that carryover ([request tracking](src/lost-request.ts)).
- **Interrupted Runs resume from checkpoints** — a remote EOF, Connect end-stream, or trailer error is never emitted as a successful `stop`. When the failed Run produced an eligible checkpoint, the provider opens a new RPC for the same conversation and sends that state with `ResumeAction`, so completed text and tool work are not replayed. Before any stateful output, an interruption without a checkpoint can still rebase from OpenCode history. Stateful interruptions without a checkpoint are surfaced because replay would be ambiguous; retry exhaustion remains explicit. A transport closure after `turn_ended` is treated as successful completion.
- **Large reads are capped by OpenCode, and the cap is reported** — OpenCode 1.x `read` stops at `MAX_BYTES = 50 * 1024` and appends `(Output capped at 50 KB. Showing lines X-Y. Use offset=N to continue.)`. OpenCode 2 prints `Read file <path>, lines <start>-<end>` with `N: ` prefixes and, when the page ends before EOF, `[Output truncated. Continue reading with offset: N]` (50 KB or 2,000 lines); it also shortens each individual line after 2,000 characters. The provider strips either envelope before returning content to Cursor so the model cannot echo wrappers into a later write, but it re-states every partial result: a native read appends a `[Partial read: …]` marker after the content, an MCP read gets a separate notice content item, and a Pi read carries structured `PiReadExecSuccess.truncation`. Relative grep, glob, and directory entries are resolved against the workspace root. Shell stdout reaches Cursor verbatim, including whitespace around internal wrapper markers; failed streams retain partial output. Successful timeout-shaped stdout remains text. Checkpointed turns, which do not resend the system prompt, get that same root on the user message. The structured `truncated` flag alone is not enough — verified against live `gpt-5.4-mini` and `grok-4.5` sessions, both of which asserted "highly confident" that partial content was the whole file until the textual marker was added. Deliberately paged reads (explicit `offset`/`limit`) are not marked unless the host also hits the byte cap or character-truncates a line. Whole-file writes and overwriting `Add File` patches that echo the marker are rejected before OpenCode executes them; targeted edits remain possible, including edits to source that quotes the warning text. Cursor's private legacy-edit read is handled separately as described above, so an edit can operate on a workspace file larger than 50 KB without turning the capped preview into a replacement. The cap is hardcoded in OpenCode's read tool — it is not the configurable `tool_output.max_bytes`, which governs `Truncate.Service` and not read's line accumulation — so ordinary model reads still require paging with `offset`.
- **No fallback models** — if Cursor’s `AvailableModels` API is unreachable and there is no local cache, the provider exposes no models.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for user-facing release notes. New work lands under `[Unreleased]` until the next version tag.

## License

MIT
