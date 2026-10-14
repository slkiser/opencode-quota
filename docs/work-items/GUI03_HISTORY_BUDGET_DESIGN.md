# GUI-03 history and budget runtime design

Issue: [#15](https://github.com/thanhndv212/opencode-quota/issues/15). Prepared: 2026-10-09. Status: implemented, local acceptance passed on 2026-10-15; [PR #43](https://github.com/thanhndv212/opencode-quota/pull/43) / hosted CI, review and merged-main acceptance remain pending. Dependencies: GUI-02 and COR-04.

## Verified starting point (2026-10-09)

- Electron refresh now runs through `src/gui/quota-refresh-controller.ts` and `src/gui/ipc/quota.ts`. The controller distinguishes current outcomes from retained previous observations. Persistence must consume current provider outcomes, never the retained display snapshot.
- Plugin snapshot recording lives in `src/plugin.ts: captureDashboardSnapshotsBestEffort()`, using `src/dashboard/quota-snapshot-bridge.ts`. The bridge already skips value-only quota rather than inventing percentages, and writes actionable errors when a provider has no usable percentage rows.
- `src/gui/ipc/dashboard-history.ts` uses `SqlJsDatabaseAdapter`. This adapter intentionally does not persist writes; exporting its in-memory database back over `quota-dashboard.db` would overwrite concurrent SQLite changes from the plugin. GUI-03 must not turn it into a second whole-file writer.
- `DashboardApi.captureSnapshot()` currently uses the time of the write. The table's unique key is `(provider, captured_at)`. Separate plugin/GUI reads of the same cache result therefore create different rows unless the original observation timestamp travels with that result. Existing cache entries already contain that timestamp; fresh and coalesced uncached results need equivalent observation metadata.
- Existing quota snapshots and reset tables identify providers and display windows, without a trustworthy account identity column. Account-scoped schema and migration belong to ACC-02; legacy rows must remain explicitly unknown rather than being relabelled as the current account.
- Budget rule evaluation exists, but `src/gui/ipc/alerts.ts: evaluateAlerts()` accepts a caller-provided usage map with no window identity. The renderer lists rules without querying/evaluating their individual windows. Passing all-time totals to this API cannot satisfy a daily rule.

## Implementation order

1. Define observation metadata shared by provider fetches, cache hits and coalesced callers. Preserve actual observation time through cache clones and disk reads. Do not persist credentials or raw opaque account identities. Provider-cache locators are digests; any history identity extension must meet the same boundary. Version any serialized contract change and preserve legacy-read behavior.
2. Extract a shared post-fetch recording hook used by plugin and GUI. Supply original observation time to persistence so repeated views of one observation upsert the same row. Treat separate live fetches as separate observations even when percentages match. Keep reset comparison before snapshot replacement and qualify any reset evidence against known window/account metadata; unknown identities cannot establish an account transition. Persistence failure must be visible as a diagnostic while quota display continues.
3. Add a bounded Node helper for native SQLite writing and local usage aggregation. Electron communicates over a local process protocol, with request IDs, timeout, serialized work and disposal on quit. Use the configured runtime directories and existing database APIs. Keep Electron's sql.js reader read-only, and never export it over a live database. Handle absent Node/native bindings, process failure and database contention as unavailable history/usage. Do not add another provider fetch loop.
4. Evaluate enabled budget rules in main against freshly aggregated `day`, `week`, `month` or `all` windows. Aggregate once per distinct window for each evaluation; preserve source/provider/model buckets instead of using priced model totals for connector scopes. Use one captured upper timestamp. A read error produces an unknown evaluation, not zero spend or a triggered below-threshold rule. Do not treat unpriced cost as known zero USD.
5. Publish budget evaluation state to renderer and tray from the same post-refresh flow. Re-evaluate after rule create/update/delete. Keep budget thresholds separate from reset notifications, and expose an unsubscribe path for budget updates. Show each rule's actual evaluation time, window and unknown/error status.
6. Add fixture-copy upgrade/restart/rollback checks and installed-package runtime evidence. Record the exact boundary between GUI-03 plumbing and ACC-02 account/schema work before claiming any account isolation or migration completion.

## Acceptance gates

| Gate                     | Required evidence                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone snapshots     | A fixture provider refresh creates persisted quota history without an OpenCode toast; errors persist without invented percentages; value-only usage remains value-only           |
| Shared observation dedup | Plugin and GUI recording one cached/coalesced observation create one row, including across process restart; two distinct live observations with identical values remain distinct |
| Writer safety            | Two real Node writers and an Electron reader preserve all writes; busy/locked database, helper death, missing binding and persistence failures leave quota display usable        |
| Time-window correctness  | Independent daily/weekly/monthly/all-time fixtures cross thresholds differently; one aggregation per distinct window; fixed upper bound; no all-time/day substitution            |
| Scope and unknowns       | Provider/model/global source totals match; unpriced cost and read failures yield unknown; below-threshold rules do not fire on failed reads                                      |
| Desktop state            | Actual installed app publishes history/budget updates while hidden, re-evaluates rule edits, unsubscribes listeners and quits helper/timer work                                  |
| Compatibility            | Old history/config fixture copies remain readable; rollback preserves data; any account identity/schema dependency is explicitly documented and tested                           |

## Implemented behavior (2026-10-15)

- Cache v3 adds a non-secret random observation ID and actual observation time. Cached/coalesced readers retain it; legacy v2 snapshots receive deterministic SHA-256 observation IDs. Distinct fresh fetches stay distinct even in the same millisecond. Account cache scope remains unchanged.
- Plugin and Electron use `recordQuotaObservations()` after the existing provider loop. Native SQLite serializes/deduplicates provider + observation ID. Existing schema-v1 tables remain intact; real time stays in JSON metadata when a storage-key collision requires a different unique key. Reads sort/filter by actual observation time, including out-of-order writes.
- A bounded serialized `HistoryHelperClient` starts a real system Node worker, using `node:sqlite` or optional `better-sqlite3`. IPC has request IDs, queue/time limits, failure recovery and disposal. Electron's sql.js reader never exports over the live database. WAL-mode histories are refused for writing rather than silently changing journal mode; unavailable writers/reads produce diagnostics.
- Main evaluates one aggregate per distinct rolling day (24h), week (7d), month (30d) or all-history window, with one upper timestamp. Provider/model scopes use source attribution, not pricing aliases. Unpriced costs, unreadable usage and malformed budget rules stay unknown. Rule edits re-evaluate locally without fetching providers.
- Renderer/tray consume the same budget state. History updates, rule status/time/range, diagnostics and unsubscribe handlers are wired. Each unsubscribe returns undefined across the Electron bridge. Quit disposes worker and controller work.

## Account, reset and rollback boundary

History remains explicitly `accountIdentity: "unknown"`; no account is invented for old or new rows. These are provider observations, not account-specific history. Existing reset rows remain readable. The new shared recording path does not infer new resets from an unqualified provider percentage jump; trusted account/window continuity belongs to ACC-02 and INS-01. Budget alerts are local usage thresholds, not reset notices.

No dashboard table is replaced, and no whole-file writer is added. Old readers still see schema-v1 rows and percentage JSON fields; new observation/error metadata is additive. Cache v3 reads valid account-scoped v2 records; older packages may discard/refetch v3 cache files, which are disposable. Rollback restores the prior package without deleting the dashboard DB or budget rules. A Node runtime with SQLite support is required for the helper; absent Node/bindings and WAL mode are explicit unavailable states.

## Local acceptance evidence (2026-10-15)

Node 22.23.3 / pnpm 10.0.0: typecheck/build, full Vitest suite, installed-tarball consumer check and separate-process account-cache smoke passed. The final local full suite passed 143 files / 1,476 tests. Provider HTTP is fixture-backed; no live-provider certification is claimed.

| Gate                                                                                                    | Local evidence                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone persistence, hidden refreshes, failure rows, rule edits, subscriptions, real helper shutdown | Installed-tarball macOS Electron 42.5.0 smoke using real main/preload/renderer/controller/helper/SQLite with fixture HTTP and usage DB |
| Observation dedup, same-ms distinct results, legacy v2 reads, clone/restart stability                   | `tests/quota-state.test.ts`, account-identity tests and separate-process cache smoke                                                   |
| Two real Node writers + WASM reader; restart and legacy history readability                             | `tests/gui.history-process.test.ts`                                                                                                    |
| Out-of-order reads, locked DB, no fabricated percentages/value rows, WAL refusal                        | `tests/gui.history-persistence.test.ts`                                                                                                |
| Day/week/month/all boundaries from a real usage DB; corrupt transcript unavailable                      | `tests/gui.history-process.test.ts`                                                                                                    |
| Source scopes, unpriced cost, one request per distinct window, unavailable reads/rules                  | `tests/gui.budget-evaluation.test.ts`, budget-alert and Claude-storage tests                                                           |
| Missing Node, helper timeout/death/idle exit and pending disposal                                       | `tests/gui.history-client.test.ts`                                                                                                     |

The first sandbox-only full run could not bind the local HTTP test server; the full run with socket permission passed. A new regression reproduced incorrect current-history ordering before the fix. A loaded concurrent-writer run exposed journal-mode probing before the busy timeout; moving timeout configuration before that probe fixed it, and the full suite passed. FND-04 remains a separate DMG installation, signing/publisher and actual-host gate. Hosted CI and green merged-main CI are still required before closing #15.
