# GUI-01 standalone configuration

Issue: [#13](https://github.com/thanhndv212/opencode-quota/issues/13). Branch: `fix/gui-01-standalone-config`. Reviewed: 2026-10-09. Status: complete; [PR #40](https://github.com/thanhndv212/opencode-quota/pull/40) merged at `f11e8fb`, with [green main CI 37852563879](https://github.com/thanhndv212/opencode-quota/actions/runs/37852563879).

## Behavior

The Electron app uses the shared validated quota config loader. Global configuration candidates are the default; the launch working directory cannot select project settings. `opencode-quota gui --project-dir /absolute/project` explicitly includes a project root above global layers. An absolute `OPENCODE_CONFIG_DIR` is also supported. Relative environment roots are rejected with an actionable startup diagnostic because Finder's working directory is not a stable configuration base.

Provider credential resolution remains unchanged and uses trusted auth, global config and environment sources. Selecting project settings does not authorize project-local provider secrets. Legacy settings remain a fallback only when no sidecar exists, including when a sidecar is malformed.

Startup and manual Refresh load settings. `quotaApi.config.quota()` returns effective validated settings, source paths, setting provenance and validation issues; `quotaApi.config.reloadQuota()` reloads them explicitly. Configuration validation issues also appear alongside quota errors in the Dashboard. No filesystem watcher is introduced. Main uses a captured config snapshot for each fetch.

The shared provider runtime context builder replaces the GUI's duplicated field list, including explicit timeout provenance and provider plan settings. Pricing source and refresh-age policy are applied when loading configuration. Standalone mode has no OpenCode session/model selection. Provider API calls remain deterministic; no model is invoked.

## Acceptance evidence

| Scenario                                                                                        | Evidence                                                                                       |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Launch cwd ignored; global sources retain global provenance                                     | `tests/gui.quota-config.test.ts`; installed Electron smoke                                     |
| Explicit project and absolute environment roots                                                 | `tests/gui.quota-config.test.ts`; CLI forwards GUI arguments                                   |
| Config parity with plugin/shared loader under identical roots                                   | `tests/gui.quota-config.test.ts`                                                               |
| Provider enablement, plan, included allowance, timeout and explicit timeout provenance          | `tests/gui.quota-config.test.ts`; existing provider/runtime tests                              |
| Pricing source selection and refresh-age policy                                                 | `tests/gui.quota-config.test.ts`                                                               |
| Edited files reload; malformed sidecar reported without legacy fallback or raw payload exposure | `tests/gui.quota-config.test.ts`                                                               |
| Selected project secrets ignored; trusted global secret accepted                                | Chutes resolver fixture in `tests/gui.quota-config.test.ts`; existing full auth/provider suite |
| Installed main/preload expose effective config and explicit reload                              | `scripts/smoke-gui.mjs`, `scripts/fixtures/gui-smoke.mjs`                                      |

Node 22.23.3 / pnpm 10.0.0: typecheck, clean build, 138 Vitest files / 1,442 tests, installed-tarball `build:check`, and installed-tarball macOS Electron 42.5.0 smoke passed. The smoke verifies global settings despite a conflicting cwd sidecar, config reload through real IPC/preload, six tabs, manual/hidden-window refresh, version and quit. Provider IPC is fixture-backed. PR CI 37852312911 and merged-main CI 37852563879 passed all six checks, including Node 20/22 installed tarballs and Linux/macOS Electron. Live-provider, DMG installation and actual OpenCode host coverage remain outside that gate.

## Compatibility and rollback

No configuration, credential or database files are rewritten. Existing plugin/CLI config root behavior is preserved; global-only loading is an opt-in shared-loader option used by standalone desktop. Existing GUI window/theme configuration stays separate from quota settings. Reverting this slice restores the GUI's prior defaults-only behavior without a storage migration.

GUI-02 owns scheduled/coalesced main-process refresh and sleep/wake handling; GUI-03 owns history and budget plumbing. FND-04 remains open for release/publisher and host/installation evidence; GUI-01 local validation does not close that release gate.
