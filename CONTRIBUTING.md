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

## Documentation

See the [documentation index](docs/README.md) for planning documents, implemented work-item records and architecture decisions. Store project documentation under `docs/` by default. Store work-item designs and completed implementation records in `docs/work-items/`, including behavior, acceptance evidence, limitations and rollback details. Link each record from the delivery tracker and update the adoption ledger when applicable.

[UPSTREAM_DELIVERY_PLAN.md](docs/UPSTREAM_DELIVERY_PLAN.md) owns delivery status and dependencies; [UPSTREAM_ADOPTION.md](docs/UPSTREAM_ADOPTION.md) owns upstream provenance. Keep pending designs in `docs/work-items/` with their implementation and acceptance status explicit.

## Development Setup

- The published package runtime supports Node.js `>=20.0.0` (matches `package.json` engines).
- Repository development and CI use Node.js 22 with pinned pnpm 10.0.0.
- Enable the pinned package manager and install dependencies with:

```sh
corepack enable
corepack prepare pnpm@10.0.0 --activate
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

Use `pnpm run test:watch` for local iteration. `pnpm run build:check` builds and installs a real tarball in a temporary consumer, then verifies package exports, GUI assets and CLI startup. `pnpm run smoke:gui` launches that installed package through Electron with fixture IPC and isolated user state. On Linux, run it under `xvfb-run -a` if no display is available. Consumer installation skips native install scripts; this smoke verifies exports/assets and is separate from backend database tests.

## CI Checks (Automated)

PR and `main` pushes trigger `.github/workflows/ci.yml` (`CI` workflow):

- Job: `pnpm-quality` on Node `22.x`
- Steps: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run build`, `pnpm test`, then `pnpm pack --pack-destination` to upload the package tarball artifact
- Job: `runtime-smoke` on Node `20.x` and `22.x`
- Runtime smoke installs the packed package as a consumer with npm and verifies default/server imports, raw TSX resolution, CLI startup, GUI assets and runtime engine metadata.
- `desktop-smoke` launches the installed package on Linux and macOS and verifies the real main/preload/renderer, six tabs, version, manual refresh, hidden-window tray refresh and quitting. Provider data is fixture-backed; this is not live quota validation.
- `required-gate` fails when any quality, consumer or desktop job fails or is skipped.

Release workflow `.github/workflows/publish-npm.yml` publishes only `@thanhndv212/opencode-quota` from an existing version-matching tag. It tests and smokes the exact tarball before publishing it with provenance, using `next` for prereleases. Configure npm trusted publishing for this repository/workflow/environment before enabling publication. Version changes belong in a reviewed PR before tagging; the workflow never edits versions or pushes commits.

`.github/workflows/desktop-artifacts.yml` prepares unsigned desktop candidates and checksums for review from a selected commit/tag. It does not publish a GitHub release or install over the maintainer's application. Artifact generation is distinct from signed/notarized release validation.

## Branch Protection (Maintainers)

Recommended settings for `main`:

- Require a pull request before merging.
- Require branches to be up to date before merging.
- Require the `required-gate` check from workflow `CI`; it requires all applicable quality, runtime and desktop jobs.
- Select checks exactly as GitHub displays them in repository settings.
- Typical names look like `pnpm-quality`, `runtime-smoke (20.x)`, `runtime-smoke (22.x)` or `CI / ...` variants.
- Block direct pushes to `main` for non-admin users.

## Repo Guardrails

- Never invoke an LLM/model API to compute toast/report output. Everything must remain local and deterministic.
- Deterministic slash commands are dual-surface:
  - the TUI dialog/palette path renders local dialogs and must not call `session.prompt()`;
  - the server/web/desktop path registers `cfg.command`, injects ignored/no-reply output with `session.prompt({ noReply: true, ignored: true })`, and must throw `handled()` so OpenCode does not continue into `prompt(...)`.
- Server/web/desktop slash commands (`/quota`, `/quota_status`, `/quota_announcements`, `/pricing_refresh`, `/tokens_*`) must route through `buildQuotaDialogCommandOutput()`; do not duplicate command-output logic in `src/plugin.ts`.
- The handled-sentinel path can surface popup/log noise until upstream adds a clean cancellation API; keep docs aligned with anomalyco/opencode#18554 and anomalyco/opencode#18559.
- Keep `handled()` / `isCommandHandledError(...)` tests aligned with the server/web/desktop handled-sentinel boundary.
- `injectRawOutput()` is shared by server/web/desktop slash commands and the server `tool.quota_status` compatibility path. Do not reuse it for TUI dialog command output.
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
