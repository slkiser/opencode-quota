# ACC-02 account/window history and additive migration

Issue: [#17](https://github.com/thanhndv212/token-watcher/issues/17). Status: complete; [PR #47](https://github.com/thanhndv212/token-watcher/pull/47) merged at `4e3bd4f`; [main CI 38702627029](https://github.com/thanhndv212/token-watcher/actions/runs/38702627029) passed all six checks. Evidence date: 2026-10-15. Dependencies: ACC-01 and GUI-03 complete.

## Identity boundary

History correlation is a separate HMAC-SHA256 domain from the internal resolved-auth cache identity. It uses the protected per-install key and an explicitly supplied stable principal; it never serializes the principal, token, email or internal `rai1_` identity. Cache keys continue to separate credential rotation, while history can retain a stable principal across rotation. Missing protected storage or missing stable principal produces unknown history identity.

OpenAI currently supplies its selected `accountId`, which is also used for the actual ChatGPT account request header. Preparation freezes that ID and credential together. Ordinary and forced fetches use that prepared snapshot; changing login after preparation cannot rebind the observation. Providers without a stable selected principal remain unknown, including current Copilot adapters. This is a coverage boundary, not a claim of inferred identity for all providers. The shared fetch pipeline overwrites provider/display identity claims with the prepared identity and binds accounting rows to it.

## Storage and rollback

Schema v2 adds `accounting_observations`, keyed by provider/account/observation/row with explicit window identity and original observation time. Legacy snapshots, usage and reset tables are unchanged. Rich rows and legacy percentage rows commit together under `BEGIN IMMEDIATE`; retries and concurrent plugin/GUI writers deduplicate one observation. Typed value-only data is stored separately, without a fabricated percentage row. Old rows remain unknown and are not relabelled as the active account.

Upgrading a native v1 database first uses SQLite `VACUUM INTO` to create a consistent backup at `<database>.pre-v2-<random>/history.sqlite`. The directory is private (0700) during creation and the finished file is 0600. Backup failure prevents migration. Schema DDL/version recording are transactional; interrupted/failed migration leaves v1 data and its backup intact and can retry. Reopening v2 does not create another backup. Concurrent first upgrades may each preserve a backup.

Electron's sql.js adapter still reads an ephemeral copy and never exports/overwrites a live file or makes a disk backup. It can read both versions; an old writer updating a v1 file continues to show legacy rows and no invented rich data. Native Node, optional better-sqlite3 and actual Bun SQLite paths are exercised. Existing WAL refusal remains an explicit standalone-helper limitation.

Rollback to the prior package is supported through unchanged legacy tables and percentage JSON; its migrator ignores higher versions and older readers/writers continue to operate. Rich rows remain on disk for re-upgrade. For restoration, stop all writers, preserve the current database, and copy the pre-v2 backup into place before reopening the previous package. Never restore a copied SQLite file over a running writer. Stable schema-v1 exports and CLI threshold semantics remain unchanged; a future rich export requires its own version.

## Acceptance evidence

Local checks passed: Node 22.23.3 / pnpm 10.0.0 typecheck, 146 files / 1,503 tests, installed-tarball consumer, separate-process account cache and history smokes, Bun 1.3.14 SQLite history smoke, installed macOS Electron 42.5.0 smoke. CI now runs both native Node and pinned Bun history compatibility inside the required quality job.

Tests cover actual v1 data and independent backups, repeat upgrade, injected partial-DDL failure/rollback/retry, atomic row failure, two accounts/windows for one provider, unknown legacy rows, value-only zero data, restart, two real helper writers with a WASM reader, token rotation and login switch after auth selection. An initial Bun run rejected an existing empty VACUUM target accepted by Node; creating the target inside a private directory fixes both runtimes and protects it during creation.

Live provider certification, OS notification delivery and release installation/signing remain separate roadmap gates. Account/window-qualified reset detection belongs to INS-01; the legacy provider-only reset heuristic remains disabled.
