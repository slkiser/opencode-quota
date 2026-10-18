# Documentation

Use the [project README](../README.md) for installation, configuration and usage, and the [contributing guide](../CONTRIBUTING.md) for the development workflow.

## Implemented work items

Project documentation lives under `docs/` by default. Work-item designs and completed implementation records live in `work-items/`; each document states its status. They preserve implementation contracts, acceptance evidence, known limits and compatibility or rollback details. Work-item IDs and existing filenames are retained for traceability.

| Item   | Record                                                                          | Scope                                                                         |
| ------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| COR-02 | [Account-safe cache implementation](work-items/COR02_CACHE_DESIGN.md)           | Resolved-auth snapshots, provider cache policies and process/restart evidence |
| COR-05 | [Provider payload and window contracts](work-items/COR05_PROVIDER_CONTRACTS.md) | Copilot credits/billing, OpenAI windows, acceptance and rollback              |
| GUI-01 | [Standalone configuration](work-items/GUI01_STANDALONE_CONFIG.md)               | Config roots, provenance, shared provider context and pricing policy          |
| GUI-02 | [Standalone refresh controller](work-items/GUI02_REFRESH_CONTROLLER.md)         | Main-process scheduling, coalescing, retained observations and suspend/resume |

These are the completed items with dedicated records. Other completed items have evidence in the delivery tracker. Validation claims retain their original dates and fixture/platform limits.

## Delivery and provenance

- [Token Watcher rename and migration](work-items/TOKEN_WATCHER_RENAME.md): package/app identity, preserved user data and renamed release acceptance.
- [Token Watcher 3.11.0-rc.3 release notes](RELEASE_NOTES_3.11.0-rc.3.md): renamed desktop and package distribution.

- [Upstream delivery plan](UPSTREAM_DELIVERY_PLAN.md): authoritative work-item status, dependencies and acceptance/release gates.
- [Upstream adoption ledger](UPSTREAM_ADOPTION.md): source-to-fork provenance and capability mapping.
- [GUI-03 history and budget runtime record](work-items/GUI03_HISTORY_BUDGET_DESIGN.md): complete in PR #43; merged-main CI passed.
- [ACC-01 accounting adapter record](work-items/ACC01_ACCOUNTING_ADAPTER.md): complete in PR #45; structured facts and legacy compatibility, with green main CI.
- [ACC-02 history identity record](work-items/ACC02_HISTORY_IDENTITY.md): complete in PR #47 with green main CI; additive migration, account/window history and rollback.
- [ACC-03 accounting surface record](work-items/ACC03_ACCOUNTING_SURFACES.md): complete in PR #48 with green main CI; shared details and account-separated history.
- [INS-01 durable reset record](work-items/INS01_DURABLE_RESETS.md): complete in PR #49 with green main CI; qualified transitions, atomic dedup and delivery state.

- [INS-02 notification delivery record](work-items/INS02_NOTIFICATION_DELIVERY.md): complete: Linux X11/Dunst and permitted local macOS native card/action accepted; distribution limits recorded.

- [INS-03 fixed-window runway record](work-items/INS03_FIXED_WINDOW_RUNWAY.md): complete in PR #51 with green main CI; strict eligibility and shared estimates.

- [PRO-01 OpenRouter record](work-items/PRO01_OPENROUTER.md): complete in PR #52 with green main CI; live credential unavailable.

- [PRO-02 Kilo record](work-items/PRO02_KILO.md): complete in PR #53 with green main CI; live credential unavailable.

- [CUS-01 remote definition record](work-items/CUS01_REMOTE_DEFINITIONS.md): complete in PR #54 with green main CI; two real HTTP fixture protocols.

- [UA-TW-02 Codex session reader record](work-items/UA_TW02_CODEX_SESSION_READER.md): in progress; native Codex rollout usage in token reports.

- [CUS-02 durable local estimate record](work-items/CUS02_DURABLE_LOCAL_ESTIMATES.md): complete in PR #55 with green main CI; native journal, pricing coverage and installed CLI/Electron evidence.

- [CUS-03 guided provider setup](work-items/CUS03_GUIDED_PROVIDER_SETUP.md): complete in PR #56 with green main CI; preview, explicit write, JSONC preservation and rollback.

- [Fork release candidate record](work-items/FND04_FORK_RELEASE_CANDIDATE.md) and [3.11.0-rc.2 notes](RELEASE_NOTES_3.11.0-rc.2.md): completed draft artifact/identity gate, exact artifact/runtime evidence and remaining OS/release limits.

- [3.11.0-rc.2 follow-up notes](RELEASE_NOTES_3.11.0-rc.2.md): native navigation heading correction; exact Linux native/AppImage and scoped local macOS native acceptance passed.

## Architecture decisions

- [Dual deterministic command surfaces](adr/0002-dual-deterministic-command-surfaces.md): server/web/desktop command output and local TUI dialogs.
