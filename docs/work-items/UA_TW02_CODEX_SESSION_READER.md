# UA-TW-02 native Codex session usage reader

Issue: [#69](https://github.com/thanhndv212/token-watcher/issues/69) (epic [#67](https://github.com/thanhndv212/token-watcher/issues/67)). Status: in progress; implementation is in review. Evidence date: 2026-10-18. Dependencies: none.

## Contract

`src/lib/codex-cli-storage.ts` reads Codex CLI rollouts from `$CODEX_HOME/sessions/**/rollout-*.jsonl` (default `~/.codex`) and returns the shared `OpenCodeMessage` shape. It reads token counts and identifiers only; conversation text is parsed with the line but never returned, stored or logged. There are no remote or model calls.

- **Authoritative source.** `token_usage_record` lines carry one response's own `usage` and a unique `response_id`. When a rollout has any of them, only they are used.
- **Fallback.** Rollouts without records use `event_msg`/`token_count`. Each event contributes the increase in its cumulative `total_token_usage`. Repeated events add nothing, and a missed event is covered by the next cumulative total. Summing `last_token_usage` is never used, because it double counts repeated events.
- **Buckets.** Codex reports cached and cache-write input inside `input_tokens`, and reasoning inside `output_tokens`. They are moved into exclusive `cache.read`, `cache.write` and `reasoning` buckets, so the bucket sum equals Codex's `total_tokens`.
- **Identity.** The session is the `session_meta` thread id; the provider is `model_provider` (default `openai`); the model comes from the `turn_context` of the record's turn. Message ids are `codex:<response_id>` (records) or `codex:<thread>:<cumulative total>` (fallback). They are deduplicated across files, so a resumed rollout that repeats earlier responses counts them once.
- **Subagents.** Review/subagent threads are separate rollouts with their own usage and are reported as their own sessions; no parent total includes them.
- **Missing data.** A missing directory, a rollout without `session_meta`, and a rollout without usage all yield no messages rather than zero-usage sessions. Malformed lines are skipped unless `strictReads` is set.

`aggregateUsage()` folds Codex messages into its global branch alongside OpenCode and Claude Code. Session-scoped OpenCode reports do not read Codex, because the session id namespaces differ.

## Acceptance evidence

- Fixture tests (`tests/lib.codex-cli-storage.test.ts`) cover record-only counting next to duplicate `token_count` events, cumulative fallback with a repeated and a missed event, subset-to-bucket mapping, resumed-file deduplication, subagent threads, since/until and mtime pruning, malformed lines with and without `strictReads`, missing directories, unknown lines and `CODEX_HOME`.
- `tests/quota-stats.test.ts` proves Codex is folded into the global aggregate and not read for session-scoped aggregation.
- Local reconciliation on 2026-10-18 (macOS, 20 Codex threads, 1,987 responses): for every thread, the reader's bucket sum equalled the final `thread_token_usage.total_tokens` exactly. Only totals were printed; no rollout content was copied.
- `pnpm run typecheck`, `pnpm run build` and `pnpm test` (163 files / 1,686 tests) passed locally on Node 26.4.0. The project's Node 22 CI is the reference run.

## Limits and follow-ups

- Reported counts are what Codex recorded, not subscription quota consumption or billing. Models without pricing (for example `codex-auto-review`) appear as unpriced.
- Rollouts that only use the `token_count` fallback can under-report if the final events were never written; there is no way to recover them.
- Codex CLI rollouts can be selected as a source for local custom estimates using `"sources": ["codex-cli"]` with `providerId: "openai"`; journal source identity stays separate from OpenCode to avoid deduplication collisions. `token-sync` does not export Codex sessions; UA-TW-06 owns the export.
- Linux rollouts were not available for local reconciliation.

## Rollback

Remove the `iterCodexCliMessages` call from `aggregateUsage()`. The reader is read-only and adds no storage or schema; reports return to OpenCode and Claude Code sources only.
