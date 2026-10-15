# INS-01 durable quota reset transitions

Issue: [#19](https://github.com/thanhndv212/opencode-quota/issues/19). Status: complete in [PR #49](https://github.com/thanhndv212/opencode-quota/pull/49), merged at `ef2abeb`; [main CI 38744283981](https://github.com/thanhndv212/opencode-quota/actions/runs/38744283981) passed all six checks. Evidence date: 2026-10-15. Dependency: ACC-02 complete.

## Detection contract

Adapt the confirmed-boundary/replenishment logic from upstream [`c2dca3c`](https://github.com/slkiser/opencode-quota/commit/c2dca3c14904fef36712b682b28b54d9d7c149d0), hardening [`cedee73`](https://github.com/slkiser/opencode-quota/commit/cedee73770bb11fb9fa860c2545899dd46782650), as reviewed at 4.x `2733b5b`. The fork uses its account-qualified accounting observations and native SQLite transactions in place of upstream's JSON observation/notification file.

A transition requires the same known opaque account, provider/source/row/window identity and provider-reported quota/rate-limit facts; an observation before the old reset; a distinct newer observation after that boundary; a newer future reset boundary; and actual replenishment. Missing identities, missing boundaries, rolling or explicitly partial-reset windows, stale/future observations, old transitions, source timestamps still in the old period and ordinary consumption do not qualify. Display labels and a wall-clock jump never establish reset. No universal ten-percentage-point threshold is borrowed from legacy retrospective history.

Application observations must be fresh (at most five minutes old) and the old reset at most 24 hours ago, matching the conservative upstream transition-age boundary. When a provider supplies source observation time, that evidence must independently reach the new period. The event records the actual reported remaining percentage; it does not promise full replenishment to 100 percent.

## Persistence and delivery state

Schema v3 adds reset events alongside unchanged legacy snapshot, usage and reset tables. The deterministic event identity covers provider, opaque account, source, row/window and both boundaries. Baseline comparison, event creation and accounting/legacy writes share one native transaction, so failed observations cannot leave a notification event behind. Concurrent plugin/GUI writers and restarts record one event.

Delivery is separate from detection. Disabled delivery or an empty explicit watch list claims nothing. An atomic lease selects one channel/process; only that channel and lease token can acknowledge delivery. Explicit delivery failure releases the event for retry. Successful delivery persists its acknowledgment across restart. An expired in-flight lease becomes **uncertain**: an OS notice might have appeared before a crash, so the system neither marks it delivered nor automatically repeats it. INS-02 exposes that status and an explicit retry choice. Exactly-once external notification across an unacknowledged process crash is not claimed.

Detection itself makes no provider/model calls and shows no notices. User preferences, preferred desktop/plugin policy, notifications and click navigation belong to INS-02. The old provider-only reset heuristic stays disabled; legacy reset rows remain readable.

## Migration and rollback

Native upgrades create a private, consistent SQLite `VACUUM INTO` backup before DDL. After acquiring the writer lock they recheck the schema version; if another process won, their unused snapshot is removed and the operation re-evaluates. This avoids advertising a newer snapshot as a pre-upgrade backup. No ordinary filesystem copy/read opens the live SQLite database in a native writer process. SQLite documents that [closing a separate descriptor can cancel the process's advisory locks](https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_).

The two-process upgrade regression reproduced corruption with an intermediate filesystem-copy approach; SQLite-managed snapshots and locked version checks fix it. The regression checks both live and backup integrity and confirms the retained backup is schema v2. Backups remain under `<database>.pre-v<next>-<random>/history.sqlite`, with 0700 directory and 0600 file. Before manual restore, stop all writers, preserve the current DB and verify `PRAGMA integrity_check` on the chosen backup. Rollback to earlier packages can keep the additive tables and use unchanged legacy tables; restoring a backup is an explicit recovery operation, never an automatic overwrite of a live file.

## Acceptance evidence

Node 22.23.3/pnpm 10.0.0: typecheck, 149 Vitest files / 1,538 tests, clean installed-tarball consumer, account-cache process smoke, actual native Node/Bun 1.3.14 history/reset lease/ack compatibility and installed macOS Electron 42.5.0 smoke passed. PR #49 and merged-main CI 38744283981 passed all six checks.

Tests cover rollover, consumption, missing/unknown/account-switched data, stale source/cache, clock jumps, small valid replenishment, rolling/partial windows, concurrent v2 upgrade and integrity, atomic observation/event rollback, two real helper processes claiming different channels, acknowledged restart dedup, failure retry, uncertain crash recovery and corrupt-state fail-closed/repair. Live-provider and OS delivery certification remain separate; current known-account coverage follows ACC-02's selected OpenAI principal contract.
