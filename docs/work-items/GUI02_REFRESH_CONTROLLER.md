# GUI-02 standalone refresh controller

Issue: [#14](https://github.com/thanhndv212/opencode-quota/issues/14). Branch: `fix/gui-02-refresh-controller`. Reviewed: 2026-10-09. Status: complete; [PR #41](https://github.com/thanhndv212/opencode-quota/pull/41) merged at `0139dd8`, with [green main CI 37853670522](https://github.com/thanhndv212/opencode-quota/actions/runs/37853670522).

## Behavior and boundaries

Electron main owns startup, timed and tray refresh. Renderer visibility does not control scheduling. Automatic refresh uses the configured quota TTL and provider cooldown path; explicit refresh reloads quota settings and requests fresh data. A request arriving during equivalent work shares its promise. Manual requests during an automatic query queue one subsequent fresh query, without overlapping provider work. Concurrent manual callers share that fresh query.

The next timer starts after a query completes. `gui-config.json`'s `refreshIntervalMs` defaults to five minutes, accepts 10 seconds through 24 hours, and uses zero to disable scheduled/wake refresh. Smaller positive values clamp to 10 seconds, larger values clamp to 24 hours, and malformed values use the default. Loading and writing config normalize the interval. Updating or resetting GUI config reschedules the controller. Failures delay subsequent automatic attempts with 30-second exponential backoff capped at 15 minutes, or the configured interval if longer. Manual retries remain available; provider-specific cooldowns still apply.

Suspend cancels the timer. Resume performs one cache-aware refresh, coalescing with any pending work. Quit disposes timers, ignores late results and suppresses queued queries. An already-issued HTTP transaction remains subject to its provider deadline; disposal does not add a new cancellation mechanism.

`quotaApi.quota.state()` provides current data, fetching/stale state, attempt/success/observation timestamps and the next refresh time. `quotaApi.quota.onUpdate(callback)` publishes main-process snapshots with a scoped unsubscribe function. Monotonic revisions keep delayed IPC replies from overwriting newer renderer state. Startup reads this state instead of requesting a second query. Tray refresh invokes the controller directly, including with a hidden window.

A failed or unexpectedly empty refresh retains a visibly labelled previous observation; it never blends old rows into a partially successful new result. Partial results replace old rows and display their current errors. Retained rows are historical observations, not confirmation of the current account's quota. Explicit quota setting changes clear retained data before the next query. Data is process-local, does not persist credentials, and uses the existing account-safe quota pipeline.

## Acceptance evidence

| Scenario                                                               | Evidence                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Startup and timer refresh without renderer work                        | Fake-clock controller tests; installed Electron real main/controller/provider HTTP fixture                             |
| Hidden-window timer and tray refresh                                   | Installed Electron smoke with request counts and captured real tray menu handler                                       |
| Automatic/manual overlap and fresh-query semantics                     | Deferred-promise controller tests; installed five-caller manual overlap produces one HTTP request                      |
| Failure/backoff/recovery, empty results and partial results            | Fake clocks and state assertions; installed HTTP 503 retains labelled observation, then clears stale state on recovery |
| Suspend/resume, interval changes, disabling and quit                   | Fake-clock controller tests; installed power-event handlers, config IPC updates and actual process exit                |
| Interval persistence and malformed values                              | `tests/lib.gui-config.test.ts`, `tests/gui.quota-refresh-controller.test.ts`                                           |
| Renderer updates, snapshot isolation, revisions and scoped unsubscribe | Controller tests; installed main/preload/renderer smoke                                                                |

Node 22.23.3 / pnpm 10.0.0: typecheck, clean build, 139 Vitest files / 1,455 tests, installed-tarball consumer check and actual macOS Electron 42.5.0 smoke passed. Validation results are recorded in the delivery tracker. Provider HTTP and power events are fixtures; this does not establish live provider, physical OS sleep/wake, DMG installation or notification coverage. PR CI 37853397937 and merged-main CI 37853670522 passed all six checks: quality/process isolation, Node 20/22 installed tarballs, Linux/macOS installed Electron, and the required gate.

## Compatibility and rollback

No database or credential migration. Existing GUI interval settings are normalized on load and persist as normalized values on subsequent writes. Prior packages can read this field. Reverting the slice restores renderer-triggered manual refresh without a storage migration. Quota settings remain in the shared sidecar, separately from GUI window/theme/interval settings.

GUI-03 follows with standalone history and budget evaluation; it does not add a second refresh loop. FND-04 release/publisher and host/install gates remain open.
