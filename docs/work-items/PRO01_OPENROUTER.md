# PRO-01 — OpenRouter key caps and spend

Issue: [#22](https://github.com/thanhndv212/opencode-quota/issues/22). Status: implemented; local acceptance passed; hosted checks and merge pending. Evidence date: 2026-10-15. Dependencies: ACC-03 and COR-01 complete.

Upstream review: initial `adee0361dd49fd18002cf7fad733c8b47a46c4b9`, diagnostic hardening `81244a9d32698072202a4c027a8a905b525675c4`, mature adapter at `2733b5bd010f659d1d6007e5d19026e82d51353f`, and main at `0819759854fa65c68daf53296972e890f9ad3f5c` (credential-database diagnostic changes only for this adapter). This fork uses its existing structured accounting and resolved-auth cache contracts rather than importing upstream's custom-provider engine or newer host auth path.

The [current key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) supports one authenticated GET to /api/v1/key. The adapter reads key caps, spend, budget rows and free request counters. It ignores deprecated rate-limit objects, raw key labels and private IDs in display. [Limit semantics](https://openrouter.ai/docs/api_reference/limits) distinguish account credit balance from key caps; lifetime spend is not current-period spend. Explicit null caps are unlimited key caps; missing or malformed limits remain unknown. Zero denominators never yield invented percentages. Negative remaining values preserve over-limit state. Budget resets remain identified boundaries, not fabricated fixed-window evidence.

Authentication precedence: OPENROUTER_API_KEY, trusted global OpenCode JSON/JSONC provider config, then existing OpenCode auth.json API-key login. Environment templates are restricted to the provider's allowed variable; workspace-local secrets are ignored. The README's three-path wording is supported by passing resolver tests. The selected key/source are captured once for cache identity and fetch; env/config/auth changes invalidate the cache. Credentials and internal cache identities never appear in display/history/export rows. Source diagnostics show only the selected source name.

The endpoint does not provide a stable key principal suitable for history correlation. Public account identity and source observation time remain explicitly unknown; creator/workspace labels, partial key labels and credentials are not substituted. These rows cannot trigger account-qualified reset notices or fixed-window runway. The application observation retains normal fetch/cache freshness separately.

Transport uses the whole-response deadline, GET only and redirect refusal. HTTP errors expose only status; response bodies, tokens and exception payloads never become diagnostics. Oversized/malformed envelopes fail safely; malformed optional rows yield bounded warnings while retaining valid rows. Budget arrays are bounded to 64 rows. USD quantities and percentages use shared accounting presentation; no OpenRouter-specific renderer logic or model endpoint is introduced.

## Acceptance and rollback

Node 22.23.3/pnpm 10.0.0: typecheck; 154 files / 1,593 tests; clean installed-tarball consumer; account-cache process smoke; actual native Node/Bun 1.3.14 history compatibility; installed macOS Electron 42.5.0 smoke passed. Auth, parser, native cache-selection and identical desktop IPC/command/toast/sidebar fixtures cover unlimited/unknown/zero/negative/malformed/partial states and secret-free failures. Desktop quota IPC makes one provider request per fetch. Installed Electron smoke validates package startup and the existing real HTTP-fixture pipeline; OpenRouter-specific surface semantics are fixture-backed unit integration evidence.

Read-only live validation was attempted conditionally on this Mac: no configured OpenRouter credential was available. No live quota, subscription, host integration or signed release certification is claimed.

Rollback: remove openrouter from enabledProviders or revert this slice. No database migration. Existing historical unknown-account rows remain readable. No changes to Qwen, Antigravity or existing adapters.
