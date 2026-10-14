# COR-05 provider payload and window contracts

Issue: #12. PR: [#39](https://github.com/thanhndv212/opencode-quota/pull/39). Branch: `fix/cor-05-provider-contracts`. Status: complete; PR #39 merged at `377c5a3`, with [green main CI 37820466327](https://github.com/thanhndv212/opencode-quota/actions/runs/37820466327). Reviewed 2026-10-09.

## Provenance and adaptation

The Copilot port uses the complete parser/billing implementation at `84c2a330b9b741392dfbd4635f3f0e1dd4c9ce0f`, including these reviewed changes:

- `5d7d435fb197722511ff1b5b456982dd55883d03`: AI Credit reports, explicit legacy billing selection and plan-only placeholders.
- `7e6d26d1f8618b2e225a41de264683c4327a0cea`: validated GHE.com routing bound to the selected credential.
- `98b2aedf205bfa278bc894be4e907a4cdea8cc49`: complete-response timeout, already adapted in COR-01.
- `25d05ce892eaffdf1b0ce9536696668c5e50a9b0`: diagnostic/error redaction.
- `5c65696302dc50b3153db7fd5546b219404703f2`: included/billed quantities, dollar amounts and separate budget display.
- `84c2a330b9b741392dfbd4635f3f0e1dd4c9ce0f`: over-limit token-billing snapshots.

OpenAI window classification adapts `3e845de9e7390d1c6d77e66f0ab2f45fc5615702`. Anthropic 401/re-auth/429 coverage is already delivered by COR-03 / PR #38, merged at `ef00d42`, with green main CI 37803649093 after rerunning an abandoned macOS job.

Fork adaptations preserve the buffering HTTP interface, fresh access-token auth, legacy Copilot payload aliases and deterministic commands. The resolved-auth prepare closure captures the same credential, deployment, billing model, target and UTC month used by its cache identity and fetch. New `copilot-contract-v2` qualifiers prevent reuse of old-format Copilot results without changing shared cache storage. Upstream structured accounting/status-details APIs are deferred to ACC-01; normalized value/percentage rows work through the existing plugin, TUI, CLI and Electron pipeline.

Unlike the source's single-quantity fallback, gross-only credit usage leaves included/billed counts unknown. Partial dollar sums do not become complete billed totals. No plan-name allowance is invented for AI Credits. A reported credit denominator stays separate from a managed dollar budget.

## Acceptance matrix

| Contract                                                                                                                                | Evidence                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Current OAuth snapshots, placeholders, zero/negative remaining, provider-reported percentages, unlimited, >100% usage                   | `tests/lib.copilot-credits.test.ts`, `tests/providers.copilot.test.ts`                  |
| Legacy OAuth aliases, premium snapshots, true negative percentages, access-token absence, invalid PAT blocks OAuth                      | `tests/lib.copilot.test.ts`                                                             |
| PAT precedence, user/org/enterprise targeting, token compatibility, exact hosts, malformed responses, 401/403/429, credential redaction | `tests/lib.copilot-credits.test.ts`                                                     |
| AI Credit quantities and amounts, missing/contradictory data, explicit legacy eligibility, paginated budgets, partial budget failure    | `tests/lib.copilot-credits.test.ts`                                                     |
| Selected credential/target survives config changes; UTC month is frozen                                                                 | `tests/providers.account-cache.test.ts`, `tests/lib.copilot-credits.test.ts`            |
| Exact 5h/weekly/monthly durations, swapped/missing windows, unknown/conflicting windows, invalid values/timestamps, Business label      | `tests/lib.openai.test.ts`, sanitized monthly fixture, `tests/providers.openai.test.ts` |
| Usage-only rows stay free of invented percentage/reset on command, toast, sidebar and compact line                                      | `tests/providers.copilot.surfaces.test.ts`                                              |
| Electron IPC retains value rows and warnings with one provider query                                                                    | `tests/gui.quota-copilot-contract.test.ts`                                              |
| Deterministic command boundaries and account-safe shared cache                                                                          | Existing full suite, including required boundary tests                                  |

## Local validation

Node 22.23.3 / pnpm 10.0.0: typecheck, 137 Vitest files / 1,437 tests, installed-tarball `build:check`, formatting and `git diff --check` passed. Installed-tarball macOS Electron 42.5.0 startup, six tabs, preload, version and refresh also passed. Provider payloads are fixture-backed. PR #39 is merged at `377c5a3`; main CI 37820466327 passed. Live-provider and actual host evidence remain outside this fixture/package gate.

## Migration and rollback

No config or credential files are rewritten. Existing PAT configs without `billingModel` select AI Credits. Legacy annual Pro/Pro+ reporting requires explicit `legacy_premium_requests`; managed or ineligible tiers cannot use that mode. This changes the endpoint used by existing PAT configs and must be included in release notes. Legacy OAuth payloads remain readable.

Amounts and credits retain distinct units. No database/export schema migration is included. TypeScript consumers must handle optional totals/percentages and the new plan-only result mode. Managed AI Credit usage may make additional quota/billing requests for its applicable dollar budget, with bounded pagination; it never invokes a model. Budget failures retain usage and produce warnings.

Rollback reverts this implementation and restores the prior package/config selection together. Old results remain separated by cache qualifiers. Fixture and installed-package evidence does not certify live GitHub/ChatGPT contracts or actual OpenCode host compatibility.
