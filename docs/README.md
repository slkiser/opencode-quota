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

- [Upstream delivery plan](UPSTREAM_DELIVERY_PLAN.md): authoritative work-item status, dependencies and acceptance/release gates.
- [Upstream adoption ledger](UPSTREAM_ADOPTION.md): source-to-fork provenance and capability mapping.
- [GUI-03 history and budget runtime record](work-items/GUI03_HISTORY_BUDGET_DESIGN.md): complete in PR #43; merged-main CI passed.
- [ACC-01 accounting adapter record](work-items/ACC01_ACCOUNTING_ADAPTER.md): complete in PR #45; structured facts and legacy compatibility, with green main CI.
- [ACC-02 history identity record](work-items/ACC02_HISTORY_IDENTITY.md): complete in PR #47 with green main CI; additive migration, account/window history and rollback.
- [ACC-03 accounting surface record](work-items/ACC03_ACCOUNTING_SURFACES.md): complete in PR #48 with green main CI; shared details and account-separated history.
- [INS-01 durable reset record](work-items/INS01_DURABLE_RESETS.md): complete in PR #49 with green main CI; qualified transitions, atomic dedup and delivery state.

- [INS-02 notification delivery record](work-items/INS02_NOTIFICATION_DELIVERY.md): implemented; observed OS delivery gates remain open.

- [INS-03 fixed-window runway record](work-items/INS03_FIXED_WINDOW_RUNWAY.md): complete in PR #51 with green main CI; strict eligibility and shared estimates.

- [PRO-01 OpenRouter record](work-items/PRO01_OPENROUTER.md): complete in PR #52 with green main CI; live credential unavailable.

- [PRO-02 Kilo record](work-items/PRO02_KILO.md): complete in PR #53 with green main CI; live credential unavailable.

- [CUS-01 remote definition record](work-items/CUS01_REMOTE_DEFINITIONS.md): implemented; hosted acceptance pending, two real HTTP fixture protocols.

## Architecture decisions

- [Dual deterministic command surfaces](adr/0002-dual-deterministic-command-surfaces.md): server/web/desktop command output and local TUI dialogs.
