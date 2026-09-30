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
- Use `.github/ISSUE_TEMPLATE/provider_request.yml` to ask for a new provider.
- Write a short, specific title. The template adds the label, so no title prefix is needed.
- Issues with a very short title or a mostly empty form get the `needs info` label and one bot comment. Editing the issue to add the details removes the label.
- Only `needs info` issues go stale: marked after 14 days without activity and closed 7 days later. Other bugs and feature requests never auto-close.
- Pull requests use `.github/pull_request_template.md` and should include tested OpenCode version details.

## Development Setup

- The published package runtime supports Node.js `>=22.0.0` (matches `package.json` engines).
- Repository development uses pnpm v11, which requires Node.js `>=22` for the pnpm CLI.
- Enable the pinned package manager and install dependencies with:

```sh
corepack enable
corepack prepare pnpm@11.0.0 --activate
pnpm install
```

`pnpm install` runs `prepare`, which installs Lefthook hooks.

## Local Quality Gates

The Lefthook pre-commit hook runs Biome only on staged supported files and re-stages formatting and safe fixes. It does not run typecheck or tests.

The Lefthook pre-push hook runs exactly:

- `pnpm verify`

Run the canonical repository gate before opening a PR:

```sh
pnpm verify
```

It checks Biome linting and formatting, the pinned TypeScript toolchain, repository history/privacy, typecheck, build, the full test suite, focused four-surface parity, and package contents—in that order.

Use `pnpm run test:watch` for local iteration. Use `pnpm run build:check` when you need the build plus package dry-run check.

## Maintainer stabilization checks

These commands are for maintainers. They do not replace `pnpm verify`.

### Connected OpenCode

`pnpm run test:stabilization:tui` builds this worktree, copies `$OPENCODE_CONFIG_DIR` or the default OpenCode config directory into a `0700` temp directory, points only the OpenCode Quota plugin entries at this worktree's `dist/index.js` and `dist/tui.js`, enables sidebar/toast/compact with the prompt bar off, and launches real `opencode`. Companion plugin order and other copied settings stay as they were. The real config is never edited. OpenCode is launched only with the temp copy. That copy is deleted on exit, on prepare/copy/transform failure, and after forwarded `SIGINT`/`SIGTERM`/`SIGHUP`. After those signals, the runner waits a bounded grace period, then force-terminates the child (process group where safe) so cleanup cannot wait forever.

This uses real credentials and makes real quota/API calls.

After the first TUI session exits, the script offers a second session with the prompt bar on. Use `pnpm run test:stabilization:tui:prompt-bar` to skip the first stage. Use `pnpm run test:stabilization:web` to launch `opencode web` instead.

Web mode runs the fixed `opencode models` command directly, without a shell or model request, in the same isolated environment used for `opencode web`. Plain catalog lines count as usable models. Structured catalog entries must explicitly report a usable state; aliases and disabled, hidden, unavailable, or unknown entries are rejected. If the copied default is stale, the runner prefers the first usable same-provider model using locale-independent ordering and rewrites only the temp JSONC copy. Comments and plugin order stay intact. An empty, failed, or unusable catalog stops the Web launch and prints click/select steps. The real config is not edited. After choosing a model, run `/quota`, then `/quota_status`.

Web diagnostics live outside the temp config in a `0700` directory with a `0600` file. Runner output, server output, each log read, the number of log files, and the final file all have fixed limits and use a truncation marker. Header and cookie values, credentials, request and response bodies, serialized config, and marked private content are replaced with redaction markers. Log capture starts at the pre-launch offsets rather than copying full historical logs. Diagnostic creation, reads, and writes are best-effort; a failure cannot replace the Web child exit result, and the path prints only after a successful write. Classification requires markers in order. A generic send failure, or a busy marker without earlier successful output evidence, is `unknown-unclassified`. #272 requires hook entry, successful output evidence, and an affirmative session-busy marker. A model error is `invalid-model-before-hook` only when no hook-entry marker exists. Signals stop preflight or Web, escalate after the grace period when needed, clean the temp config, and retain the original signal exit code.

The prompt bar is a fixed 12-cell bar. The label is the provider plus window, for example `OpenAI 5h`. When you resize the terminal, check placement and clipping. The bar does not grow.

### Fake-data fixtures

`pnpm run test:stabilization:fixtures` runs a frozen Vitest set for config symlinks, config write targets, atomic JSON, OpenCode Go, Synthetic empty responses/surfaces, OpenRouter diagnostics/surfaces, Alibaba Token Plan process/provider, quota status, prompt selection, prompt-bar identity, TUI runtime, quota export, API-key query/config, and contribution guidance. It does not use real credentials, network provider calls, or the real `bl` executable. Before Vitest starts, the runner creates a `0700` temp HOME/XDG sandbox, strips known provider credential/session env vars and `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR`, then deletes the sandbox on success, error, or signal.

## CI Checks (Automated)

PR and `main` pushes trigger `.github/workflows/ci.yml` (`CI` workflow):

- Job: `pnpm-quality` on Node `24.x`
- Steps: frozen install, `pnpm verify`, then one exact npm artifact pack and upload
- Job: `runtime-smoke` on Node `22.x` and `24.x`
- Runtime smoke installs that exact packed artifact as a consumer and verifies the default/server imports, TUI export payload, CLI help, and `engines.node >=22.0.0`

Release workflow `.github/workflows/publish-npm.yml` first checks the release tag, SHA, and package version, then runs `pnpm verify` on Node 24. After that, it packs one exact artifact, smoke-tests that artifact on Node 22 and 24, verifies it again before provenance publishing to the `v4-latest` npm tag (npm `latest` stays on 5.x), and backfills the release version to `release/4.x`. Run `pnpm run release:check` on Node 24 when the release environment is available; it adds the release-version assertion after the canonical gate.

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
- Rich accounting currency quantities must preserve the provider's uppercase ISO code and render through the shared formatter (for example, `USD 12.50`), never a provider-formatted currency string, bare symbol, decorative glyph, conversion, or cross-currency sum.
- The server plugin is the sole owner of deterministic slash commands for TUI and Desktop/server. It registers each `cfg.command` once, injects exactly one ignored/no-reply output message with `session.prompt({ noReply: true, ignored: true })`, and must throw `handled()` so OpenCode does not continue into `prompt(...)`.
- The TUI plugin owns only Sidebar, Compact status, home-bottom, prompt-wrapper, refresh, and resource-lifecycle surfaces. It must not register keymap commands or render native slash-command dialogs.
- Slash commands (`/quota`, `/quota_status`, `/quota_announcements`, `/pricing_refresh`, `/tokens_*`) must route through `buildQuotaDialogCommandOutput()`; do not duplicate command-output logic in `src/plugin.ts`.
- The handled-sentinel path can surface popup/log noise until upstream adds a clean cancellation API; keep docs aligned with anomalyco/opencode#18554 and anomalyco/opencode#18559.
- Keep `handled()` / `isCommandHandledError(...)` tests aligned with the server/web/desktop handled-sentinel boundary.
- `injectRawOutput()` is shared by inline slash commands and the server `tool.quota_status` compatibility path.
- Keep `tests/plugin.command-handled-boundary.test.ts`, `tests/tui-smoke.test.ts`, and `tests/command-handled.test.ts` aligned with these invariants.

Additional boundary tests to keep healthy when touching plugin/provider logic:

- `tests/plugin.question-hook.test.ts`
- `tests/quota-provider-boundary.test.ts`

## Provider Changes

### Built-in Provider Policy

A built-in provider addition is eligible for review only when:

- The provider is listed on [models.dev](https://models.dev/).
- The request shows demand or recommendations from at least two independent users.
- The PR links that evidence and explains why the custom-provider feature is not enough.

A contributor's own request and repeated comments from the same person do not count as independent demand. Eligibility does not guarantee acceptance: the provider must also expose a stable accounting source and have a reasonable long-term maintenance cost.

### Choose the Right Path

- **OpenCode custom provider:** Use this to connect an OpenAI-compatible model service that OpenCode does not include automatically.
- **OpenCode Quota custom provider:** Use `provider add` for local request estimates or one supported fixed quota endpoint. Its `providerId` must exactly match a provider ID exposed by OpenCode at runtime. It does not create the OpenCode provider or support discovery, fan-out requests, or arbitrary provider logic.
- **Built-in provider:** Consider maintained code only after the provider meets the policy above and the custom-provider path cannot support its required behavior.

### Built-in Implementation

Keep README setup wording tied to real behavior.

- For API-key/token providers that reuse existing OpenCode auth, trusted global config, or approved environment variables, start from `contributing/provider-template/`.
- Copy the template files to the target paths listed in `contributing/provider-template/README.md`.
- Replace the example names, IDs, environment variables, and config keys before coding.
- Add tests for every supported auth source; do not leave copied template tests skipped, todo-only, or unresolved.
- Use the current README setup label—`Automatic` or `Needs setup`—that matches the real user workflow.
- In the PR checklist, state whether you started from the provider template; if not, explain why it does not apply.

### Accounting Result Contract

Every provider row must carry `AccountingMetadata`. Its closed `resultType` is the actual accounting meaning—`quota`, `rate_limit`, `usage`, `spend`, `budget`, `balance`, or `status`—not the shape that is easiest to render. Row-level and basis-fact authorities must also name the real origin. `user_configured` is allowed only on a basis fact, such as a configured budget limit; it is not a row-level JSON v2 authority.

For a rich provider:

- Emit numeric financial/count facts as typed `quantity` rows or percentage `basis` facts, and booleans as typed `boolean` rows. Do not preformat currency in a legacy `value` or financial `right` string.
- Provide a complete `semantic` object with an explicit `primary` or `supplementary` prominence. Do not infer prominence from order.
- Keep basis `used`, `limit`, and `remaining` values literal. A display mode may change the percentage direction but never rename one fact as another.
- Keep named metrics short and single-line. A named label contains the concept only—never a value, unit, reset string, or layout punctuation.
- Use the shared accounting formatter for human output and JSON v2 flattening. `barValue` is removed and is not an extension point.

A simple percentage-only provider can keep the legacy percent row shape without `semantic` or `basis`; it still needs accurate `AccountingMetadata`. Do not add structured semantics unless the source can support their meaning and authority.

## Quality Bar for Fixes

- Prefer the smallest safe fix that addresses the root cause.
- Align behavior with current OpenCode production behavior rather than adding extra hook/output mutation layers.
- Preserve existing invariants and update/add boundary tests when behavior contracts change.
- We appreciate PRs that verify the fix against the current production released OpenCode version and note the tested version in the PR.

## Before-and-after evidence

Changes to visible UI or human-readable output require matching before-and-after screenshots of the affected surfaces. Capture both versions with the same configuration, model/provider, theme, and window size, and redact credentials, account identifiers, private paths, and other sensitive information.

Quota-related changes must report a result for Web output, the TUI sidebar, toast, and the compact line below the message input. Identify unchanged or untested surfaces explicitly. Include the prompt bar or command dialog when relevant.

Formatter tests do not count as screenshot evidence. Screenshots do not replace tests, and formatter tests do not replace checking the real client.

If there is no visible effect, write `Not applicable` and explain briefly.

## Pull Request Checklist

- Linked issue (`Fixes #...` or `Refs #...`) when available, or included a short no-issue rationale in the PR.
- `pnpm verify` passes.
- Verified behavior against the current production released OpenCode version, and included the tested version in the PR notes.
- Included matching before-and-after screenshots for visible changes and recorded the required surface checks, or explained why this does not apply.
- Updated docs when user-facing commands/config/workflow changed (usually `README.md`; update this file when contributor workflow changes).
- For built-in provider additions, linked the models.dev entry, evidence from at least two independent users, and an explanation of why the custom-provider feature is insufficient.
- For new API-key/token providers, started from `contributing/provider-template/` or explained why the template does not apply.
- For provider setup/auth wording changes, checked `contributing/provider-template/` and verified the current README setup label against implementation and tests.
