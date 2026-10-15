# PRO-02 — Kilo personal balance and Pass facts

Issue: [#23](https://github.com/thanhndv212/opencode-quota/issues/23). Status: complete in [PR #53](https://github.com/thanhndv212/opencode-quota/pull/53), merged at `4e16d7a`; [main CI 38751113522](https://github.com/thanhndv212/opencode-quota/actions/runs/38751113522) passed all six checks. Evidence date: 2026-10-15. Dependency: PRO-01 complete.

Selected Kilo as the next self-contained Gateway adapter. This does not imply the user has a Kilo subscription. OpenCode Zen's current Console integration is not replaced with obsolete billing-page scraping or a new host/auth migration. The existing OpenCode API-key login alone does not certify a compatible Console session.

Upstream review covered initial balance support, `091b5d9` Pass reporting, `648a837` tRPC corrections, `884ba5f` fallback/display changes, `a28ff0a` removal of misleading reset metadata, `d5ec3518b1cbecde8a4a8be08e3df9888d41c037` raw accounting, `52958ac` response bounds, and `452f430` accounting migration. Mature lib/kilo.ts at `2733b5bd010f659d1d6007e5d19026e82d51353f` is unchanged at reviewed main `0819759854fa65c68daf53296972e890f9ad3f5c`; its later credential-database auth/diagnostic migration remains under the explicit OpenCode 2 compatibility gate.

The current primary server contract was reviewed at Kilo cloud `87f598083f28880fc42698b2fb5c44b6641e024c`: [personal balance route](https://github.com/Kilo-Org/cloud/blob/87f598083f28880fc42698b2fb5c44b6641e024c/apps/web/src/app/api/profile/balance/route.ts) and [Pass schema/usage composition](https://github.com/Kilo-Org/cloud/blob/87f598083f28880fc42698b2fb5c44b6641e024c/apps/web/src/routers/kilo-pass-router.ts). Personal balance is authoritative. Pass period usage already includes credit-funded hosting. Projected bonus credit is distinct from an actual issued bonus; it must not increase spendable balance. Billing renewal is not a confirmed quota reset.

The fork therefore makes two bounded parallel GET requests with the same frozen personal credential: api.kilo.ai/api/profile/balance and app.kilo.ai/api/trpc/kiloPass.getState. Balance remains a USD quantity, including zero/negative values. Pass base, spend, included hosting and issued/potential bonus facts stay separate. No percentage, full-reset window or available-credit sum is fabricated. Missing/ambiguous legacy bonus state remains unknown. Explicit subscription:null means no active Pass; malformed/missing subscription data is an error. Either valid endpoint remains visible if the other fails.

Authentication precedence: KILO_API_KEY, trusted global provider.kilo.options.apiKey in OpenCode JSON/JSONC, then existing auth.json API-key login. All advertised paths pass tests; workspace secrets and arbitrary env templates are ignored. Organization/delegated tokens and organization headers are not supported by this personal adapter. Credentials remain private; cache identity binds selected auth and both requests. Stable public history identity/source observation remain unknown rather than being decoded from unsigned JWT claims or inferred from fetch time.

Responses are bounded, redirects refused, diagnostics generic and credential-free. No inference endpoint, model call, CLI executable, extra polling loop or provider-specific GUI code is introduced. No permissions or login state are changed.

## Acceptance and rollback

Node 22.23.3/pnpm 10.0.0: typecheck; 157 files / 1,620 tests; clean installed-tarball consumer; account-cache process smoke; native Node/Bun 1.3.14 history compatibility; installed macOS Electron 42.5.0 smoke passed. Auth and rotation tests, parser/partial-data/deadline fixtures and shared desktop IPC/command/sidebar/toast rendering verify the contract. The two-request bound is asserted. Installed Electron smoke certifies package startup and existing HTTP-fixture integration; Kilo-specific source semantics remain fixture-backed.

Conditional read-only live validation found no configured Kilo personal API credential on this Mac. No live subscription, organization, OS notification or signed-release certification is claimed.

Rollback: remove kilo from enabledProviders or revert the slice. No database migration or changes to existing provider behavior. History remains explicitly unknown-account where source identity is unavailable.
