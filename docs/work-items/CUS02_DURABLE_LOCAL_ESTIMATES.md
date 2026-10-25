# CUS-02 — Durable local accounting definitions

Issue: [#25](https://github.com/thanhndv212/token-watcher/issues/25). Status: complete. PR #55 merged at `77ea5d1`; all six merged-main CI 38760769638 checks passed. Evidence date: 2026-10-15. Dependencies: CUS-01 and COR-04 complete.

Adapted from the local-estimate capability in upstream `2733b5bd010f659d1d6007e5d19026e82d51353f/src/lib/quota-providers-local.ts`. The fork uses its existing native helper, source-aware usage readers and user pricing policy rather than an independent writer or provider-specific renderer.

Definitions are trusted global `quotaProviders` entries with `mode: "local-estimate"`. Remote/auth fields are rejected. Select OpenCode, Claude CLI, Codex CLI, or any combination; `providerId` and optional exact `modelIds` scope observations. OpenAI and Codex share the `openai` provider ID, while their journal identities remain separate to prevent collisions. Declare at most 16 UTC-day or bounded rolling windows, each with an integer request limit and optional positive USD budget. Exact `pricingModelMap` entries supply fallback model identities only when automatic pricing is unavailable. To estimate Codex usage against a user-configured OpenAI limit:

```json
{
  "id": "custom-openai-codex",
  "providerId": "openai",
  "label": "OpenAI Codex local estimate",
  "mode": "local-estimate",
  "sources": ["codex-cli"],
  "windows": [
    { "id": "day", "label": "UTC day", "type": "utc-day", "requestLimit": 100, "usdBudget": 10 }
  ]
}
```

These are estimates from observed local completions against user-configured limits, not provider billing or account quota. Account identity stays unknown. Declared UTC-day windows have explicit local boundaries; rolling windows do not invent reset times. Missing/unreadable sources make current percentages unknown and expose retained counts as incomplete, rather than claiming zero usage.

OpenCode reads completion time, including requests created before the active window. Canonical copies are deduplicated without collapsing genuine repeated requests with identical facts. Hashed message aliases and fingerprint multiplicity slots survive source copy deletion, reordering and restart. Known aliases are reserved before new copies acquire slots. Sources remain separate; no speculative cross-source collapse. Claude CLI prefers the stable provider completion ID; an event UUID is accepted only with recognized terminal completion evidence. Stream updates share one completion identity, and uncertain legacy chunks fail closed. Partial final usage retains request counts while USD coverage is unknown.

SQLite schema v5 adds event and alias tables, written transactionally by the native Node helper. SQL.js remains read-only. Raw session/message IDs are not journal keys. Reads and retention are bounded: 100,000 source rows, 200,000 events and 400,000 aliases per definition, configured lookback plus one day. Source failures, malformed identity records and overflow fail closed. Concurrent v4 upgrades retain one private consistent SQLite backup and recheck schema under the migration lock. Events and aliases roll back together on write failure.

Token facts are retained and repriced without incrementing counts. Effective models.dev pricing, user cost overrides and explicit fallback model maps apply. Every consumed token bucket needs a finite known price; absent rates or final tokens make USD budget percentages unavailable while preserving requests. No model API, provider HTTP request or independent polling loop computes these estimates. Local definitions are uncached: ordinary CLI `show --details` fetches them through the helper; stable JSON-v1/threshold output remains cache-only and therefore reports local sources unavailable.

## Acceptance and rollback

Node 22.23.3/pnpm 10.0.0: typecheck; 160 files / 1,659 tests; clean installed-tarball consumer; account-cache process smoke; native Node/Bun 1.3.14 compatibility; installed macOS Electron 42.5.0 and installed plain CLI passed. Real SQLite helper processes cover concurrent v4 migration, canonical copies, genuine repeats, restart, completion-time selection, pricing overrides/fallbacks and incomplete-price behavior. Pure tests also cover independent UTC/rolling totals, source separation, stream identity, atomic rollback and journal corruption.

Installed Electron displays one observed request as 90% remaining against a limit of ten across repeated refreshes, while the USD budget remains unknown without pricing. The same installed CLI exits normally with the same facts. Refresh does not increase provider HTTP calls. Custom provider selection persists and filters entries/details by stable provider ID. This GUI-only entry metadata does not alter provider cache or public JSON-v1 entries. The [inspected narrow renderer capture](evidence/CUS02-local-estimate-narrow.png) shows source authority, user-configured limit and missing-price explanation. Sources and HTTP services are isolated fixtures; this does not certify live provider billing, user history completeness or actual host command routing. No user settings were changed.

Rollback: remove/disable the definition and reload settings. Preserve the database and its private pre-v5 backup; do not downgrade a schema-v5 writer in place. Restore an isolated copy of the pre-v5 backup for an older application, retaining the newer database for recovery. Removing a definition stops old provider objects from fetching; retained local journal data is not exported as provider-reported quota.
