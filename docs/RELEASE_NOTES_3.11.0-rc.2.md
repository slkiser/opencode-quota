# 3.11.0-rc.2 — Fork delivery candidate

Draft GitHub desktop/tarball distribution for `@thanhndv212/opencode-quota`. No npm publication or signed/notarized release is claimed.

This candidate also fixes the active-tab heading after native notification navigation or a full renderer rebuild. Real Linux Dunst diagnostics showed the action callback already selected the correct provider/account/window; the stale heading was the remaining UI regression. The prior 3.11.0-rc.1 tag and exact artifacts remain preserved.

This candidate adds account-safe cache selection, bounded provider fetch/recovery, structured accounting and source-aware history, standalone scheduling and windowed budgets, durable opt-in reset delivery, strict fixed-window runway estimates, OpenRouter/Kilo adapters, bounded global remote definitions, durable local estimates and guided JSONC provider setup. Legacy deterministic plugin/TUI surfaces and cache-only JSON-v1 exports retain their contracts.

Use [guided setup](work-items/CUS03_GUIDED_PROVIDER_SETUP.md) for custom sources and [notification configuration](work-items/INS02_NOTIFICATION_DELIVERY.md) for explicit watched windows. Reset notices default off. Request/USD local estimates are based on observed local completions against user-configured limits; incomplete sources or pricing remain unknown.

The [candidate acceptance record](work-items/FND04_FORK_RELEASE_CANDIDATE.md) documents versions, exact artifact evidence, limits and rollback. Development uses Node 22 and pnpm 10.0.0; installed tarball CI covers Node 20/22. Electron is 42.5.0. Actual OpenCode 1.18.10 testing stores deterministic ignored output without model requests but exposes handled aborts as HTTP 500. Interactive host UI, real OS delivery and signing gates remain explicit.

Preserve your settings/database and private migration backups before upgrading. Do not open a newer schema with an older writer; rollback to an older app requires an isolated copy of the appropriate pre-migration database. Do not overwrite the newer database or discard unrelated later config edits. Native Node/Bun and fixture upgrades/rollback are tested; fixture evidence does not certify live accounts.

Selective upstream sources remain pinned to 4.x `2733b5bd010f659d1d6007e5d19026e82d51353f` and main `0819759854fa65c68daf53296972e890f9ad3f5c`; full provenance and adapted follow-ups are in [the adoption ledger](UPSTREAM_ADOPTION.md). OpenCode 2 migration and metrics remain deferred/optional decisions.
