# Changelog

## [Unreleased]

## [0.8.3] - 2026-10-18

### Added

- Muse Wonder pricing, context, and capability metadata from Cursor's model docs

### Fixed

- A Cursor Task with attached files hands the subagent exact file paths to open itself, keeps Cursor's description, and avoids extra parent reads, including runtime metadata attachments; unstatable attachments report failure ([#82](https://github.com/oakimov/cursor-opencode-provider/issues/82), based on a fix by [@nkoynov](https://github.com/nkoynov))
- Shell results preserve whitespace when removing internal wrapper markers, retain partial output on stream failures, and keep successful timeout-shaped output unchanged in both native host projections ([#98](https://github.com/oakimov/cursor-opencode-provider/pull/98))
- Like Cursor CLI, a shell call that fails in OpenCode, such as one in a missing working directory, reaches Cursor once as stderr instead of as both stdout and stderr, in streamed and unary shell results ([#101](https://github.com/oakimov/cursor-opencode-provider/issues/101), reported by [@nkoynov](https://github.com/nkoynov))
- Shell output reaches the model exactly as the command printed it, as with Cursor CLI. Lines such as branch names, `#!/bin/sh` or `PREFIX=/usr/local` were prefixed with the workspace path, and relative paths printed after a `cd` pointed at the wrong directory ([#96](https://github.com/oakimov/cursor-opencode-provider/issues/96), based on [#54](https://github.com/oakimov/cursor-opencode-provider/pull/54) by [@nkoynov](https://github.com/nkoynov))
- After a restart, a turn that resumes a saved conversation no longer attaches every image in the session's history again, and an image you attach is not sent again as history on the next turn ([#78](https://github.com/oakimov/cursor-opencode-provider/pull/78) by [@nkoynov](https://github.com/nkoynov), [#75](https://github.com/oakimov/cursor-opencode-provider/issues/75))
- On OpenCode 1.x, GPT edits keep existing CRLF line endings even when Cursor sends the replacement as LF ([#81](https://github.com/oakimov/cursor-opencode-provider/pull/81) by [@nkoynov](https://github.com/nkoynov))
- Patch conversions preserve blank lines and reject paths or file content they cannot preserve exactly
- On OpenCode 1.x and 2, file writes and edits use the current turn's permitted tools after a model switch; OpenCode 2 GPT models use `patch` instead of first failing on `write` ([#81](https://github.com/oakimov/cursor-opencode-provider/pull/81) by [@nkoynov](https://github.com/nkoynov), [#80](https://github.com/oakimov/cursor-opencode-provider/issues/80))
- On OpenCode 2, Stop stops the Cursor Run instead of leaving it generating, or waiting for a tool result, until your next message ([#58](https://github.com/oakimov/cursor-opencode-provider/pull/58) by [@nkoynov](https://github.com/nkoynov))
- A Run whose stream is cancelled mid-generation, as OpenCode 1.x does on Stop, is cancelled at Cursor so the next message resumes from where it stopped, and a tool result Cursor has withdrawn is no longer sent back ([#58](https://github.com/oakimov/cursor-opencode-provider/pull/58) by [@nkoynov](https://github.com/nkoynov))
- A turn stopped mid-step keeps its Cursor conversation and prompt cache at the next message, also after a restart ([#58](https://github.com/oakimov/cursor-opencode-provider/pull/58) by [@nkoynov](https://github.com/nkoynov), [#74](https://github.com/oakimov/cursor-opencode-provider/issues/74))
- On OpenCode 2, plain-text steers without files or skills can reach Cursor during a background-shell wait; queued messages are preserved after Stop and mixed tool continuations, and answered copies are deduplicated across restarts and retries while preserving later identical requests and neighboring attachments ([#57](https://github.com/oakimov/cursor-opencode-provider/pull/57) by [@nkoynov](https://github.com/nkoynov))
- On OpenCode 2, a steer that Cursor took after tool results is no longer sent twice when its Run drops and cannot be recovered; the retried step rebuilds from host history ([#92](https://github.com/oakimov/cursor-opencode-provider/pull/92) by [@nkoynov](https://github.com/nkoynov))
- Large file writes stay alive while Cursor is composing them and sending frames; like Cursor CLI, an active Run with no pending host work now retries after 30 seconds of complete silence ([#66](https://github.com/oakimov/cursor-opencode-provider/issues/66))
- Long-running tools keep their Cursor Run alive with the same exec heartbeats Cursor CLI sends
- Errors show Cursor's own explanation (for example "Request blocked by Anthropic …"), and a request Cursor marks as not retryable is no longer retried by OpenCode (OpenCode 2 sent it 11 times in testing; OpenCode 1.x resent a used-up usage limit five more times because of its message wording)
- Like Cursor CLI, errors that need your action (usage or rate limits, sign-in, pricing, API key, outdated client), a bare `permission_denied`, and authentication failures, including those before a Run opens, end the turn instead of being retried; on OpenCode 1.x this also covers final `internal`/`unknown` errors. Final Cursor details take precedence over token renewal ([#97](https://github.com/oakimov/cursor-opencode-provider/pull/97))
- Once the provider spends its retry budget, or cannot replay a Run without repeating a tool call or other side effect, OpenCode no longer starts another retry loop ([#97](https://github.com/oakimov/cursor-opencode-provider/pull/97))
- Like Cursor CLI, a Run that drops or stalls after showing only text or reasoning, before Cursor saved a checkpoint, is retried by OpenCode instead of ending the turn, and the request reaches Cursor in that retry instead of with your next message. A retry after a checkpoint resumes the turn's latest checkpoint, and two resumes that save nothing end the turn ([#100](https://github.com/oakimov/cursor-opencode-provider/issues/100), reported by [@nkoynov](https://github.com/nkoynov))
- Retry counts now follow Cursor CLI: up to 10 transport retries (including streams that end without `turn_ended`) and 3 server retries per user turn, shared across checkpoints and OpenCode retries, including OpenCode 2's interruption notices with appended host reminders. `CURSOR_ENDLESS_RETRIES=1` or `true` bypasses count limits while preserving replay guards and the no-progress and stall cutoffs ([#103](https://github.com/oakimov/cursor-opencode-provider/pull/103))
- A dropped or stalled Run with an unfinished tool display row can be retried when no exec or started tool lifecycle arrived; the row closes without executing a tool ([#103](https://github.com/oakimov/cursor-opencode-provider/pull/103))
- Tool recovery accepts checkpoints received while a completed result drains, and retains completed results across resumed Runs even when exec IDs restart ([#103](https://github.com/oakimov/cursor-opencode-provider/pull/103))
- Interrupted Runs retain their checkpoint across credential renewal, including a rejected login on an untouched resumed attempt. A drop immediately after completed tools can recover from complete host history before new output, without resuming a checkpoint predating their results. Other stateful activity remains a replay barrier. Follow-ups accept checkpoints received while opening the new Run. An ambiguous replacement upload ends the turn instead of retrying through an older checkpoint, including in endless mode ([#103](https://github.com/oakimov/cursor-opencode-provider/pull/103))
- On macOS, a shell command that printed nothing before being moved to the background no longer reports `head: illegal byte count -- 0`
- A tool that is still running no longer lets its Cursor Run expire at the inactivity limit. The Run stays open until the tool finishes, for up to four hours from when that tool started
- An edit Cursor starts announcing shows its tool row while the arguments are still streaming. If that call never runs, the row closes instead of being left for the host to execute. Edits of files outside the workspace, or of files the provider cannot read, open no row before OpenCode's `read` of that file, and an edit of an empty file shows its `write` row, so neither leaves a failed edit row behind. When the call still runs as a different tool, such as a rewrite with unchanged content that stays a `write`, the row completes and names that tool instead of reporting a failure ([#73](https://github.com/oakimov/cursor-opencode-provider/issues/73), [#106](https://github.com/oakimov/cursor-opencode-provider/issues/106), based on a fix by [@nkoynov](https://github.com/nkoynov))
- A message Cursor never checkpointed is sent again ahead of the next message on the same conversation. Stopping the turn, or a rebuild from the host's history, drops it. It also survives an OpenCode restart after the failed turn, and repeated failed retries no longer add the same interruption note again each time ([#66](https://github.com/oakimov/cursor-opencode-provider/issues/66))
- On OpenCode 2, a title or summary request sent while a tool is still running no longer cancels the Cursor Run waiting on that tool
- While a tool runs, the provider answers Cursor's blob requests and stop requests at once, as Cursor CLI does, instead of after the tool finishes
- A large request, such as the first one after a restart in a session with screenshots, no longer fails with "backpressure drain failed" when it takes more than 5 s to upload; stopping a turn also cancels initial, tool-result, and replacement uploads at once ([#75](https://github.com/oakimov/cursor-opencode-provider/issues/75), based on [#77](https://github.com/oakimov/cursor-opencode-provider/pull/77) by [@nkoynov](https://github.com/nkoynov))
- A headless process now exits after its last Cursor Run instead of hanging on the idle cached HTTP/2 connection ([#88](https://github.com/oakimov/cursor-opencode-provider/pull/88) by [@willowite](https://github.com/willowite), [#87](https://github.com/oakimov/cursor-opencode-provider/issues/87))
- A new Run no longer fails at its start with `NGHTTP2_ENHANCE_YOUR_CALM` while other Runs on the same connection are still uploading large requests, and on Node a single large request no longer fails the same way on a slow uplink ([#76](https://github.com/oakimov/cursor-opencode-provider/issues/76), based on [#79](https://github.com/oakimov/cursor-opencode-provider/pull/79) by [@nkoynov](https://github.com/nkoynov))
- Unsupported effort hints keep an advertised default tuple, and model discovery and explicit selections reject duplicate parameter ids ([#84](https://github.com/oakimov/cursor-opencode-provider/pull/84) by [@willowite](https://github.com/willowite))
- Synthetic context model entries retain Cursor's declared default effort when the default is a Fast variant or belongs to another max tier ([#86](https://github.com/oakimov/cursor-opencode-provider/pull/86) by [@willowite](https://github.com/willowite))
- Grok 4.7, 4.6 and 4.5 now run Cursor's declared default level (High) when no reasoning effort is configured; before, they ran at the lowest level because Cursor's default is a Fast variant that the resolver skips ([#86](https://github.com/oakimov/cursor-opencode-provider/pull/86) by [@willowite](https://github.com/willowite))
- A configured reasoning effort now reaches models whose Cursor parameter is `reasoning_effort` (Grok 4.7, Gemini 3.8 Flash, Gemini 4 Argon, Claude Sonnet 5.5 and Haiku 5.5); before, only models with an `effort` or `reasoning` parameter honored it and the others always ran Cursor's default variant ([#84](https://github.com/oakimov/cursor-opencode-provider/pull/84) by [@willowite](https://github.com/willowite))
- Grok 4.7's 500k variants run in max mode instead of failing with `Cursor API error (code=not_found)`; max mode now follows the max-mode flag Cursor sets on each variant, as Cursor CLI does, instead of only a 1m context. A `maxMode` option without a picked variant lands on the model's declared max default even when Cursor declares a Fast variant (Grok 4.7 500k High, GPT-5.2 High). The model list is fetched again once after upgrading ([#67](https://github.com/oakimov/cursor-opencode-provider/issues/67))
- Grok 4.7's 500k variants have separate `-500k` and `-500k-fast` model entries with matching context limits and pricing ([#95](https://github.com/oakimov/cursor-opencode-provider/pull/95))
- Effort hints stay in the requested context tier and Fast-only max tiers remain selectable ([#95](https://github.com/oakimov/cursor-opencode-provider/pull/95))
- Models Cursor reports as not supporting non-max mode run every variant in max mode, as Cursor CLI does ([#95](https://github.com/oakimov/cursor-opencode-provider/pull/95))
- A configured reasoning effort changes only the effort of Cursor's default variant; Claude models with a thinking parameter no longer switch to their non-thinking variant ([#95](https://github.com/oakimov/cursor-opencode-provider/pull/95))
- Unmarked 1M variants retain their max-mode fallback after model discovery and cache reload; explicit non-max markers remain authoritative ([#95](https://github.com/oakimov/cursor-opencode-provider/pull/95))
- Saved 500k variant selections on base and Fast model entries remain available after upgrading; dedicated 500k entries still provide the full host context budget ([#95](https://github.com/oakimov/cursor-opencode-provider/pull/95), reported by [@nkoynov](https://github.com/nkoynov))
- With a long OpenCode cache path, Cursor's project folder (agent tools, terminals, generated assets) stays inside the cache's `projects` directory instead of being created next to the cache directory; project folders that already worked keep their names ([#102](https://github.com/oakimov/cursor-opencode-provider/issues/102), reported by [@nkoynov](https://github.com/nkoynov))

## [0.8.2] - 2026-10-15

### Added

- Gemini 4 Argon pricing, context, and capability metadata from Cursor's model docs

### Changed

- A new session runs workspace discovery (`git status`) once instead of separately for its title and its first turn ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49))
- OpenCode 2 with several projects open renews a Cursor login and looks up its agent host once per process instead of once per project ([#70](https://github.com/oakimov/cursor-opencode-provider/pull/70))
- Debug log: `finish:` and usage-validation counters are labelled by source (`raw*`, `occupancy*`, `est*`), `rawReadVsPriorContext` is shown as a multiple (`3.00x`), and cache diagnoses say why a Run started cold (`coldReason`) ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49))
- Pull request reviews follow the repository review rubric (`docs/review-rules.md`), including blocker checks for secrets, entrypoints, provider boundary, and protocol evidence

### Fixed

- Background shells write their output as it arrives, and their real exit status, to the terminal file Cursor polls, including after cancellation, a hard timeout or a killed supervisor ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov), [#48](https://github.com/oakimov/cursor-opencode-provider/issues/48))
- Shell commands that finish inside their foreground window report their real exit code ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- A shell command that reaches its hard timeout is reported as timed out, not as a background job, even while it is still being stopped ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- Shell output that happens to look like the provider's result lines no longer changes the reported outcome ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- Cursor's shell commands use OpenCode's configured shell instead of sometimes falling back to `$SHELL` ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- On OpenCode 2, shell commands started with OpenCode's own `background` option stay OpenCode background jobs, and their completion notice continues the Cursor turn without running the command again ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- On OpenCode 2, identical shell commands started at the same time no longer take each other's background handling ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- Cursor's tool-catalog files and terminal polling no longer trigger file or directory approval prompts ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- On OpenCode 2, denied or failed reads, writes, deletes and shell commands reach Cursor as failures instead of successes ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov), [#63](https://github.com/oakimov/cursor-opencode-provider/issues/63))
- Reads Cursor sends through MCP reach OpenCode's `read` tool for directories and missing paths, with its permission prompt, instead of failing ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- A new message after you reject or interrupt a tool keeps the Cursor conversation when Cursor confirms the cancellation, and otherwise rebuilds it from OpenCode history instead of reusing a stale checkpoint ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov))
- Cursor is told where past chats live only when `CURSOR_AGENT_TRANSCRIPTS_FOLDER` points to an existing directory ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51) by [@nkoynov](https://github.com/nkoynov), [#69](https://github.com/oakimov/cursor-opencode-provider/issues/69))
- On OpenCode 1.x, a shell command that timed out still reaches Cursor as timed out when its result is replayed from history, such as after a restart ([#51](https://github.com/oakimov/cursor-opencode-provider/pull/51))
- Instruction and skill updates OpenCode adds after a tool result, such as a nested `AGENTS.md` picked up by a read, reach the model in the same turn instead of leaking into the read's content or being dropped; an update Cursor does not take is sent with the next message ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49) by [@nkoynov](https://github.com/nkoynov))
- On OpenCode 2, a nested `AGENTS.md` loaded mid-step no longer restarts the Cursor turn, and updates added between messages, such as MCP server instructions, are no longer dropped ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49) by [@nkoynov](https://github.com/nkoynov))
- On a slow or broken connection, tool results and the reads the provider answers itself are no longer dropped, sent twice or replayed half-written ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49) by [@nkoynov](https://github.com/nkoynov))
- A rebuilt Cursor conversation (after compaction, an interrupted turn, a restart without saved state, or a return from another model) keeps your `AGENTS.md`, skills and subagents instead of losing them for the rest of the session ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49))
- A tool waiting on a permission or question prompt keeps its Cursor turn however long you take to answer, instead of losing it after 10 minutes ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49))
- A `git status` that fails or times out is reported to Cursor as incomplete instead of as a clean working tree ([#49](https://github.com/oakimov/cursor-opencode-provider/pull/49))
- The first Cursor request after a restart no longer waits for every saved conversation to be decompressed ([#68](https://github.com/oakimov/cursor-opencode-provider/issues/68))
- Saved conversations expire on a long-running server without a restart, including snapshots in an older cache format and files left by an interrupted save ([#72](https://github.com/oakimov/cursor-opencode-provider/pull/72))
- Saved and restored conversations no longer keep a second copy of their state in memory for the life of the process ([#72](https://github.com/oakimov/cursor-opencode-provider/pull/72))
- On OpenCode 2, new Runs use the current Cursor login even when OpenCode's generic loader set up the SDK first ([#70](https://github.com/oakimov/cursor-opencode-provider/pull/70))
- A rejected Cursor login stays rejected between renewal attempts, unusable renewal responses back off, and a forced renewal uses its new token even when the expiry is unchanged ([#70](https://github.com/oakimov/cursor-opencode-provider/pull/70))
- Session cost on OpenCode 1.x and 2 follows Cursor's billing: an estimate during the turn, reconciled at Cursor's published rates when it ends (OpenCode 1.x showed $0, and OpenCode 2 billed every tool step as a new prompt) ([#71](https://github.com/oakimov/cursor-opencode-provider/pull/71))
- The debug log's usage validation no longer counts the footer's output token twice, and reports a mismatch when its total differs from what was sent ([#71](https://github.com/oakimov/cursor-opencode-provider/pull/71))

## [0.8.1] - 2026-10-08

### Added

- Cursor models see host skills the way Cursor presents them: RequestContext `agent_skills` with each skill's file path and description (no content), so matching skills can be loaded by reading the file when the host advertises `skill` ([#62](https://github.com/oakimov/cursor-opencode-provider/pull/62) by [@nkoynov](https://github.com/nkoynov))
- Claude Haiku 5.5 pricing, context, and capability metadata from Cursor's model docs

### Changed

- External contributions are welcome again; PR descriptions must stay concise and human-readable
- CreatePlan writes plans where OpenCode keeps them: the session's own plan file on OpenCode 1.x (`.opencode/plans/` in a git project, otherwise the data `plans/` folder) and the Plan directory (`~/.opencode/plan`) on OpenCode 2.0, instead of a provider-chosen folder
- Cursor follows the OpenCode agent on every turn, as Cursor CLI does: choosing `plan` in OpenCode's agent picker puts Cursor in plan mode, and leaving it returns Cursor to agent mode
- Cursor SwitchMode into plan mode moves the session to OpenCode's `plan` agent once the turn ends (OpenCode 2.0, and 1.x without `plan_enter`)
- In plan mode without a host `plan_exit`, CreatePlan shows the plan and asks through `question` whether to start implementing; Yes switches to the build agent and continues. Under the `plan` agent with `plan_exit`, CreatePlan writes the session plan file and runs that review instead; a host plan-stage tool receives the plan directly
- `cursor-opencode-provider/image-save` accepts `ask: null` for hosts without a permission prompt (the image is written after containment only); a missing `ask` is still refused

### Fixed

- Recovery Runs remember detached tool images without resending them on later turns; progress-only reopens use the current Run ID for host instruction updates
- Tool images stay with the correct result; unreadable or oversized images are reported without blocking other results, and recovery retains supported image formats
- Host instruction updates survive image reads, and declined tool calls return errors instead of successes
- Images returned by MCP tools reach the model in the same turn instead of after the next user message ([#46](https://github.com/oakimov/cursor-opencode-provider/pull/46) by [@nkoynov](https://github.com/nkoynov), [#45](https://github.com/oakimov/cursor-opencode-provider/issues/45))
- Images read with the `read` tool reach the model in the same turn instead of a "Media attached" placeholder ([#42](https://github.com/oakimov/cursor-opencode-provider/pull/42) by [@nkoynov](https://github.com/nkoynov))
- Cursor generations that emit several tool calls in one step now surface them together to OpenCode (instead of finishing after the first), so parallel host tools and subagents can run concurrently ([#44](https://github.com/oakimov/cursor-opencode-provider/issues/44))
- Tool-step and fresh-turn drain timeouts preserve late Cursor frames; interrupted parallel steps return pending tools without replaying already-started host calls
- A slow or failed health-check ping on the shared Cursor connection no longer aborts other chats streaming on it with "automatic retry unsafe" ([#47](https://github.com/oakimov/cursor-opencode-provider/pull/47) by [@moritzWa](https://github.com/moritzWa))
- Canceling a response with no pending tools closes the Cursor Run after its active pump stops, instead of leaving the stream and heartbeat open; tool-result continuations still retain their Run
- Tool-less title and summary Runs advertise an empty tool catalog (matching OpenCode's host-empty title/compaction Sends) instead of re-advertising the sticky set, so Cursor is not tempted to call tools on those turns
- Cache diagnosis labels zero cache-read counters on CreatePlan/SwitchMode turns without inferring cache hits from context size
- Skill locations containing HTML special characters load correctly on OpenCode 1; OpenCode 2 skill catalogs stay scoped to their own project, and structural skill lookups receive the owning session ID
- Cold-start tool-less requests finish without waiting for a sibling tool catalog; titles and summaries containing words such as "unavailable" retain their answer
- Malformed todo lists and question options remain subject to validation instead of silently clearing tasks or inventing choices
- `todowrite` calls that omit `priority` (Cursor TodoWrite shape) get OpenCode's required defaults before host validation, so todo updates no longer fail with `Missing key … ["priority"]`
- `question` calls that omit `header` get a short label from the question text before host validation, so prompts no longer fail with `Missing key … ["header"]`
- Dynamic-catalog guidance names the namespace for host tools (`opencode`) and states that `cursor` holds only Cursor's built-in tools, so a first `skill` lookup no longer fails in the wrong namespace.
- A SwitchMode handoff that starts a new host plan turn explicitly terminates the old Cursor Run before the host switch, preserving its checkpoint and preventing premature CreatePlan calls. Native planning guidance distinguishes direct functions from dynamic discovery; debug logs retain native discovery errors.
- Dynamic tool definitions carry their exact invocation identity and complete outer envelope beside the inner argument schema, so discovery and shortened search results retain required outer call fields.
- Shell calls preserve an advertised description and supply one for native commands when the canonical schema requires it, before required-argument validation.
- Dynamic-call guidance requires complete tool identities on every invocation; file tools reject misplaced shell commands, and debug logs retain server-side MCP validation errors that never reached host execution.
- Interaction guidance no longer advertises native AskQuestion as bridged without `question`, and explicitly skips optional delegation without a canonical `task`/`subagent` executor.
- Tool-less title and summary requests explicitly process supplied context without executing its task, and missing required tool arguments are rejected before host execution with a correlated correction request.
- Stale Cursor token categories no longer appear as current context metadata or cache changes; usage validation marks a retained older breakdown `stale` while checking current occupancy independently.
- Refused exec debug lines include the rejection reason, so partial-read protection can be distinguished from an invalid tool mapping.
- OpenCode 2.0 saves Cursor-generated images through `cursor_image_save` instead of refusing the binary write
- On OpenCode 2.0, an approved plan starts implementing and plans land in the Plan directory even after the plugin is set up for several locations or reloaded; before, disposing an older setup removed the newer one's agent switch and the session stopped after approval
- Assistant text before and after a tool call or plan review is separated into paragraphs instead of running together, so a shown plan's heading renders
- Session titles and summaries contain only the model's answer, not its narration before refused tools or refusal-shaped text after a lifecycle refuse
- A new message that arrives with a plan approval or plan-mode switch no longer discards the Cursor turn that raised it, and one that arrives while Cursor is still answering no longer waits for that unseen answer before starting over
- A new message sent while a plan review, question, or mode switch is still open declines it instead of leaving the earlier Cursor run open
- A pending tool result in a new message reaches its Cursor run before helper detection, so the conversation is kept even when the tool catalog shrank
- Approving a plan is not undone by plan-mode reminders the host appends after the answer, and a failed approval delivery no longer changes the mode or starts implementing
- Native agent switches run once per session at a time and keep a newer request that arrives while one is applying
- On OpenCode 1.x, a SwitchMode in a session's first turn moves it to the `plan` agent too
- Where OpenCode offers no `plan_enter`, the model is told to enter plan mode with Cursor's SwitchMode directly instead of concluding plan mode is unavailable
- With a host plan-stage tool, plan mode is kept while the host still advertises `plan_enter`
- After MCP tools appear mid-turn, the next user message reuses RequestContext instead of rebuilding it
- A Cursor run that fails before showing any output can be retried automatically again: timing, tracing, and progress fields Cursor now sends on ordinary updates no longer mark every run unsafe to retry
- The debug log's turn usage validation no longer reports `status=mismatch` when Cursor's context shrinks between steps
- Cursor models carry a model `family`, so OpenCode can write session titles with its small model (for example GPT-5.6 Luna) instead of the model you are coding with; context/speed suffixes and Kimi minor versions stay in their model's family ([#43](https://github.com/oakimov/cursor-opencode-provider/pull/43) by [@nkoynov](https://github.com/nkoynov))
- A parameterless default variant is labeled distinctly from its model in the picker.

## [0.8.0] - 2026-10-04

### Changed

- Host system context is delivered as a single always-apply rule; the provider no longer rediscovers local `AGENTS.md`, skills, or agent files for Cursor `RequestContext` ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))
- RequestContext tool overlay is names-only; full tool definitions are answered from the live host catalog on exec #36 ([#37](https://github.com/oakimov/cursor-opencode-provider/pull/37))

### Fixed

- Cursor browser-login and API-key credentials renew the same way Cursor's own clients do, so long sessions stop failing after token expiry ([#35](https://github.com/oakimov/cursor-opencode-provider/issues/35))
- Cursor conversations stay consistent across OpenCode 2.x subagents, model switches, and host mid-turn notes instead of superseding the held Run or losing tool continuations ([#34](https://github.com/oakimov/cursor-opencode-provider/pull/34))
- Recovered RequestContext and standalone tool catalogs survive restart and lifecycle turns without dropping MCP/tool state

Prior releases before the changelog was introduced are available via git tags (`v0.7.6`, `v0.7.5`, …).
