# ACC-01 structured accounting compatibility adapter

Issue: [#16](https://github.com/thanhndv212/opencode-quota/issues/16). Status: implemented; local acceptance passed; [PR #45](https://github.com/thanhndv212/opencode-quota/pull/45) awaiting hosted acceptance/merge. Evidence date: 2026-10-15. Dependencies: COR-02 and COR-05 (complete).

## Contract and provenance

Adapt the accounting result types, decimal quantities, typed percentage operands, authority, source acquisition and primary/supplementary distinction from upstream 4.x [`2733b5b`](https://github.com/slkiser/opencode-quota/tree/2733b5bd010f659d1d6007e5d19026e82d51353f), `src/lib/entries.ts` and `src/lib/accounting-format.ts`. Relevant adoption commits remain in MAP-07 of the [adoption ledger](../UPSTREAM_ADOPTION.md).

The fork keeps `QuotaToastEntry` unchanged. `QuotaProviderResult.accounting` is an optional, version-1 document, parallel to `entries`. It contains rows with stable IDs, result type, prominence, source ID/acquisition/ownership/authority, explicit account identity and source freshness, window identity and typed values. Other providers and old cache entries may omit the document; absence does not authorize parsing display strings to invent accounting facts.

- Quantities carry canonical decimal strings and currency/count/custom units. Formatting preserves precision and separate currencies; it does not sum, convert or derive a percentage. Provider numbers are expanded from exponent notation without introducing extra precision.
- Percentages remain explicit provider/adapter facts. Zero and negative remaining percentages are preserved. Missing percentages remain unknown even if operands exist, including zero/missing limits. Each operand carries its own authority.
- Quantity, boolean and status rows preserve known zero, unknown, unavailable and unlimited as separate states. Unknown numeric data projects to a value row, never a zero-percent bar.
- Account identity is unknown unless a future adapter supplies an opaque digest. Display labels, email addresses and credentials are not account IDs. The two adapters delivered here always use unknown; ACC-02 owns attribution and storage migration.
- Source freshness is unknown unless the source supplied an observation time. Application fetch/cache time is already available in `QuotaObservation` and is not relabelled as source observation time. Cached reads retain the original facts.
- Identified windows can carry a reset boundary without asserting a start or full reset. Fixed and rolling windows have explicit, validated contracts. Neither a label nor a reset timestamp establishes projection eligibility.

`projectAccountingToLegacy()` is an opt-in compatibility projection for subsequent consumers: explicit percentages become percent rows; quantities/booleans/status become value rows. It validates the document, preserves row order/group labels and reset times, and leaves source documents intact. ACC-01 does not switch existing surfaces to this projection, because that would change current value text and stable exports. ACC-03 owns shared surface integration.

## Provider integration

OpenAI exposes its exact hourly/weekly/monthly/code-review window facts. Credit availability/unlimited flags are supplementary; a reported credit balance without a declared unit remains unknown with the raw balance as detail, rather than being assigned USD. Missing windows produce no structured zero row. Legacy fallback presentation remains unchanged.

Copilot exposes quota/usage operands, count units, included/billed usage, USD spend, budget operands and the source's authority. Unlimited and plan-only responses stay separate. Missing budget spend does not become zero. Managed account display data is not copied into identity. Both selected-auth and direct fetch paths share the same adapters, with no additional provider requests.

Cache clones deep-copy accounting documents through fresh, coalesced, memory and disk reads. Invalid optional documents on disk fail validation and trigger the existing safe refetch path. Cache version 3 remains compatible: old results omit the optional document; older fork versions can read the unchanged legacy entries and ignore the added facts. No dashboard schema or export version changes.

## Acceptance evidence

Local acceptance passed on Node 22.23.3 / pnpm 10.0.0: typecheck, 145 Vitest files / 1,494 tests, clean installed-tarball consumer check, account-cache process smoke and installed macOS Electron 42.5.0 smoke. The Electron smoke exercised the real OpenAI provider path with HTTP fixtures, six tabs, hidden/timer/tray/wake/coalesced refresh, stale/recovery, history, windowed budgets, subscriptions and helper shutdown. Hosted Node 20/22 and Linux/macOS checks, merge and green merged-main CI remain pending.

Semantic tests cover mixed currencies and precise decimals, zero/missing limits, unknown/unlimited/over-limit values, authority, independent account digests, window/freshness evidence, supplementary facts and invalid metadata. Existing OpenAI/Copilot display assertions remain unchanged. Cache tests cover coalescing, mutation isolation, restart and malformed-document refetch. Export tests deliberately supply different structured percentages and prove schema-v1 JSON still uses the original legacy rows.

Fixture tests and installed-package smoke do not certify live providers, actual OpenCode-host use or signed/installed release artifacts. ACC-02 migrations and ACC-03 richer display remain planned. Rollback restores the previous package: dashboard data, rules and stable exports remain unchanged; optional cache facts may be ignored or refetched.
