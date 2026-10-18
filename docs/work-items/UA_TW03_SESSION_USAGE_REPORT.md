# UA-TW-03 session usage report

Issue: [#70](https://github.com/thanhndv212/token-watcher/issues/70) (epic [#67](https://github.com/thanhndv212/token-watcher/issues/67)). Status: in progress; implementation is in review. Evidence date: 2026-10-18. Depends on UA-TW-02 ([#69](https://github.com/thanhndv212/token-watcher/issues/69), PR [#75](https://github.com/thanhndv212/token-watcher/pull/75)).

## Command

```
token-watcher sessions [--since <YYYY-MM-DD|Nd>] [--until <YYYY-MM-DD>] [--limit <n>] [--json]
```

The default window is the last 28 days. Dates are UTC; `--until` is inclusive. Text output has source coverage, totals, a weekly trend, session-length buckets and the top sessions by tokens. `--json` prints the full report.

## Contract

`src/lib/session-usage.ts` (`buildSessionUsageReport`) reads Claude Code, OpenCode and Codex from their native stores and returns one row per root session.

- **Subagents fold into their root session.** Claude Code uses `isSidechain` subagent transcripts, Codex uses `parent_thread_id`, and OpenCode follows the session index's `parentID` to the root. Rows report `subagentResponses` and `subagentTokens`. `subagentShare` is `null` for a source that cannot mark subagents.
- **Per session:** responses, active span (first to last response in the window), model mix by tokens, token buckets, cache-read share, tokens per response, estimated cost, unpriced tokens and priced share. The project is the working directory where the source records it. Claude Code and Codex record it; the OpenCode index read has no directory, so it is `null`.
- **Weekly trend:** each response is placed in its UTC Monday week, per source and for all sources together.
- **Length buckets:** 1–10, 11–50, 51–200 and 201+ responses per session.
- **Unavailable is never zero.** These values are `null` rather than zero:
  - Cache-read share when a session has no input-side tokens.
  - Cost when nothing could be priced.
  - Duration without two timestamps.
  - Subagent share for a source that cannot mark subagents.

  Undated responses count towards their session but not towards a week, and coverage reports how many there are.

- **Coverage:** every source is `read`, `not-found` (no local store) or `unavailable` (read failed, with the first line of the error). The report also carries static notes:
  - Reported counts are not billing.
  - Cost covers only the priced share.
  - Other machines are not included (UA-TW-06).
  - Copilot and Zcode are not included (UA-TW-04).
  - A session crossing the window edge counts only its responses inside the window.
- **Privacy and determinism.** The report contains only identifiers, timestamps, directories, model ids and counts. It has no titles and no message text. There are no network or model calls, and results are sorted deterministically.

`quota-stats.ts` exports `priceTokensUsd()`, so session costs use the same pricing mapping and snapshot as `aggregateUsage()`.

## Reader fixes that change existing token totals

Two Claude Code reader fixes affect global token reports (`/tokens_*`, `token-watcher` reports and the GUI). `quota-providers-local` completion-event accounting is unchanged.

1. **Duplicate response lines.** Claude Code writes one response as several transcript lines (one per content block), and each line repeats the response's usage. The legacy read path now keeps one message per `message.id`, and the last line wins. The local transcripts on 2026-10-18 summed to 10.04B tokens per line against 4.10B per response. That is a 145% overcount before the fix.
2. **Subagent transcripts.** `<project>/<session>/subagents/agent-*.jsonl` files were not read. They added 173.8M tokens locally (4.1% of the deduplicated total), with no response id overlap with top-level transcripts.

The Codex reader now also sets `directory`, `subagent` and `parentSessionID` from `session_meta`.

## Acceptance evidence

- `tests/lib.session-usage.test.ts` covers:
  - Folding Claude, Codex and nested OpenCode subagents.
  - `null` cache share, cost and duration with undated responses kept out of weeks.
  - `null` subagent share when a source cannot mark subagents.
  - `read`, `not-found` and `unavailable` coverage.
  - Weekly and length-bucket rows, deterministic output, and no titles.
- `tests/lib.cli-sessions.test.ts` covers argument parsing, text output with `n/a` for unavailable values, JSON output and errors.
- `tests/lib.claude-code-cli-storage.test.ts` covers response-line collapsing and subagent transcripts. `tests/lib.codex-cli-storage.test.ts` covers subagent and directory metadata.
- Local run on 2026-10-18 (macOS, 28-day window, about 2 s):
  - 82 sessions and 16,224 responses: 77 Claude Code and 5 Codex sessions. OpenCode was read but had no sessions in the window.
  - 3.91B tokens, 98.2% cache-read share and 5.5% subagent share.
  - Only aggregate sections were inspected; no session content was printed.
- `pnpm run typecheck`, `pnpm run build` and `pnpm test` pass locally on Node 26.4.0. The project's Node 22 CI is the reference run.

## Limits and follow-ups

- **Pricing coverage is low.** The bundled snapshot has no rates for current models (`claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol`, `gpt-6-luna`), so 99.7% of local tokens were unpriced. The report shows priced share beside every cost and marks partly priced sessions, but cost trends are not useful until pricing is refreshed or user pricing is configured.
- **Active span is not wall-clock time.** It runs from the first to the last response in the window, and idle gaps are included.
- **OpenCode has no project directory** in this report yet.
- **No GUI view yet.** Presentation is UA-TW-05, cross-machine data UA-TW-06, and Copilot/Zcode activity UA-TW-04.
- **Linux not checked.** Linux stores were not available for the local run.

## Rollback

Remove the `sessions` command from `src/bin/opencode-quota.ts`. The report is read-only and adds no storage. To restore the previous Claude Code totals, revert the reader commit. That brings back the duplicate-line overcount and drops subagent transcripts.
