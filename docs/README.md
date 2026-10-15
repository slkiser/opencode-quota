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
- [ACC-01 accounting adapter record](work-items/ACC01_ACCOUNTING_ADAPTER.md): in progress; structured facts and legacy compatibility.

## Architecture decisions

- [Dual deterministic command surfaces](adr/0002-dual-deterministic-command-surfaces.md): server/web/desktop command output and local TUI dialogs.
