# Changelog

## [Unreleased]

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
