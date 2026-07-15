# Contributing to opencode-quota

Thanks for contributing. This repo has strict local-only behavior and regression guardrails, so please follow this workflow.

## Issue-First (Preferred)

- Prefer opening an issue before starting features, bug fixes, refactors, or behavioral changes.
- If you already have a fix ready, opening an issue and PR together is fine.
- When an issue exists, link it in the PR description using `Fixes #<issue>` or `Refs #<issue>`.
- If no issue exists, include a short rationale/scope summary in the PR description.

## Issue and PR Templates

- GitHub Issue Forms are enabled and blank issues are disabled.
- Use `.github/ISSUE_TEMPLATE/bug_report.yml` for bug reports.
- Use `.github/ISSUE_TEMPLATE/feature_request.yml` for feature requests.
- Use template title prefixes for consistent issue titles.
- Inactive issues may be marked stale after 23 days and closed 7 days later if there are still no updates.
- Bug title format: `[bug]: <short description>`
- Feature title format: `[feature]: <short description>`
- Pull requests use `.github/pull_request_template.md` and should include tested OpenCode version details.

## Development Setup

- The published package runtime supports Node.js `>=20.0.0` (matches `package.json` engines).
- Repository development uses pnpm v11, which requires Node.js `>=22` for the pnpm CLI.
- Enable the pinned package manager and install dependencies with:

```sh
corepack enable
corepack prepare pnpm@11.0.0 --activate
pnpm install
```

`pnpm install` runs `prepare`, which installs Husky hooks.

## Local Quality Gates

Pre-commit hooks currently run:

- `pnpm exec lint-staged` (formats staged files via Prettier)
- `pnpm run typecheck`
- `pnpm test`

Pre-push hooks currently run:

- `pnpm install --frozen-lockfile`

Run checks manually before opening a PR:

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

Use `pnpm run test:watch` for local iteration. Use `pnpm run build:check` when you need the build plus package dry-run check.

## CI Checks (Automated)

PR and `main` pushes trigger `.github/workflows/ci.yml` (`CI` workflow):

- Job: `pnpm-quality` on Node `24.x`
- Steps: frozen install, v4 formatting/history/TypeScript gates, typecheck, full tests, focused four-surface parity, build, then strict npm package audit
- Job: `runtime-smoke` on Node `22.x` and `24.x`
- Runtime smoke installs the exact packed artifact as a consumer and verifies the default/server imports, TUI export payload, CLI help, and `engines.node >=22.0.0`

Release workflow `.github/workflows/publish-npm.yml` runs the same release gates on Node 24 before publishing. It keeps `npm publish --access public` only for the npm registry publish step. Run `pnpm run release:check` on Node 24 to reproduce the complete local gate.

## Branch Protection (Maintainers)

Recommended settings for `main`:

- Require a pull request before merging.
- Require branches to be up to date before merging.
- Require status checks from workflow `CI` for `pnpm-quality` and every `runtime-smoke` matrix entry.
- Select checks exactly as GitHub displays them in repository settings.
- Typical names look like `pnpm-quality`, `runtime-smoke (22.x)`, `runtime-smoke (24.x)` or `CI / ...` variants.
- Block direct pushes to `main` for non-admin users.

## Repo Guardrails

- Never invoke an LLM/model API to compute toast/report output. Everything must remain local and deterministic.
- The server plugin is the sole owner of deterministic slash commands for TUI and Desktop/server. It registers each `cfg.command` once, injects exactly one ignored/no-reply output message with `session.prompt({ noReply: true, ignored: true })`, and must throw `handled()` so OpenCode does not continue into `prompt(...)`.
- The TUI plugin owns only Sidebar, Compact status, home-bottom, prompt-wrapper, refresh, and resource-lifecycle surfaces. It must not register keymap commands or render native slash-command dialogs.
- Slash commands (`/quota`, `/quota_status`, `/quota_announcements`, `/pricing_refresh`, `/tokens_*`) must route through `buildQuotaDialogCommandOutput()`; do not duplicate command-output logic in `src/plugin.ts`.
- The handled-sentinel path can surface popup/log noise until upstream adds a clean cancellation API; keep docs aligned with anomalyco/opencode#18554 and anomalyco/opencode#18559.
- Keep `handled()` / `isCommandHandledError(...)` tests aligned with the server/web/desktop handled-sentinel boundary.
- `injectRawOutput()` is shared by inline slash commands and the server `tool.quota_status` compatibility path.
- Keep `tests/plugin.command-handled-boundary.test.ts`, `tests/tui-smoke.test.ts`, and `tests/command-handled.test.ts` aligned with these invariants.

Additional boundary tests to keep healthy when touching plugin/provider logic:

- `tests/plugin.qwen-hook.test.ts`
- `tests/quota-provider-boundary.test.ts`

## Provider Changes

When adding a provider, keep the README setup wording tied to real behavior.

- For API-key/token providers that support `Existing OpenCode auth, global config, or env`, start from `contributing/provider-template/`.
- Copy the template files to the target paths listed in `contributing/provider-template/README.md`.
- Replace the example names, ids, env vars, and config keys before coding.
- Add tests for each supported auth source before using the shared README wording; do not leave copied template tests skipped, todo-only, or unresolved.
- In the PR checklist, state whether you started from the provider template; if not, explain why it does not apply.
- Do not use that wording for OAuth-only providers such as OpenAI.

## Quality Bar for Fixes

- Prefer the smallest safe fix that addresses the root cause.
- Align behavior with current OpenCode production behavior rather than adding extra hook/output mutation layers.
- Preserve existing invariants and update/add boundary tests when behavior contracts change.
- We appreciate PRs that verify the fix against the current production released OpenCode version and note the tested version in the PR.

## Pull Request Checklist

- Linked issue (`Fixes #...` or `Refs #...`) when available, or included a short no-issue rationale in the PR.
- `pnpm run typecheck` passes.
- `pnpm test` passes.
- `pnpm run build` passes.
- Verified behavior against the current production released OpenCode version, and included the tested version in the PR notes.
- Updated docs when user-facing commands/config/workflow changed (usually `README.md`; update this file when contributor workflow changes).
- For new API-key/token providers, started from `contributing/provider-template/` or explained why the template does not apply.
- For provider setup/auth wording changes, checked `contributing/provider-template/` and verified README wording against implementation/tests.
