# Contributing to opencode-quota

Thanks for contributing! Please read this before you open an issue or PR.

## Issues first

- Open an issue before a feature, fix, refactor, or behavior change. Opening the issue and PR together is fine.
- Link it in the PR with `Fixes #<issue>` or `Refs #<issue>`. No issue? Explain the reason and scope in the PR.
- Use an issue form (bug, feature, or provider request). Write a short, specific title; the form adds the label, so skip `[bug]`-style prefixes.
- Very short or mostly empty issues get the `needs info` label. Adding the details removes it. `needs info` issues close after 21 days without activity; nothing else auto-closes.

## Setup

Node.js 22.22.1+, 24.11+ or 26+ (what Vite+ and its staged-file check need; the published plugin itself runs on `^22.13.0 || >=23.4.0`), Git 2.32+ and pnpm 11:

```sh
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install
```

`pnpm install` also sets up the Git hooks with Vite+ (`vp config`): pre-commit runs `vp staged`, which formats and lints the staged files, fixes what it can and stages the fixes (rules in the `staged` block of `vite.config.ts`); pre-push runs `pnpm verify`. The hook scripts are in `.github/hooks/`. Each checkout and Git worktree runs its own copy, so run `pnpm install` in each one.

If Git's `core.hooksPath` already points to another folder, `pnpm install` leaves it alone and prints `core.hooksPath is already set to "…", skipping`, and these hooks don't run. `pnpm exec vp hooks status --hooks-dir .github/hooks` shows the current state. To skip the hooks for one command, set `VP_GIT_HOOKS=0`.

### Activate hooks in a clone that uses Lefthook

`core.hooksPath` is Git's setting for the folder containing hook programs. Linked worktrees normally share this setting. Check its source and value from the repository folder:

```sh
git config --show-origin --get-all core.hooksPath
```

If the setting comes from this repository's `.git/config` and points to its Lefthook hook folder, remove that setting and activate Vite+ from a v6 checkout:

```sh
git config --local --unset-all core.hooksPath
pnpm install
pnpm exec vp hooks enable --hooks-dir .github/hooks
pnpm exec vp hooks status --hooks-dir .github/hooks
```

The status must show `core.hooksPath` as `.github/hooks/_`, an installed dispatcher, and the `pre-commit` and `pre-push` scripts. A skipped installation does not activate these checks. If the setting belongs to another hook system or comes from global or worktree-specific configuration, keep it and resolve that setup before using these instructions.

### Working on both v4 and v6

v4 uses Lefthook and Biome; v6 uses Vite+. With the relative `.github/hooks/_` setting, each worktree needs its own installed hook programs. Run `pnpm install` in every existing worktree after activating this setting, and after switching a checkout between v4 and v6. Install dependencies before committing or pushing from a new worktree.

Git's `info/exclude` file lists local files to ignore and is shared by linked worktrees. Add the generated hook folder there once per clone so v4's installed hooks cannot be accidentally staged:

```sh
printf '\n/.github/hooks/_/\n' >> "$(git rev-parse --git-path info/exclude)"
```

## Checks

Run `pnpm verify` before opening a PR. It runs lint and formatting, the TypeScript-version and history checks, the build (its `tsc` step is the type check), all tests (the cross-surface test among them), and the package contents check. CI runs the same command, then installs the packed package on Node 22 and 24 as a smoke test, once into a project and once globally with npm 12.

For quick iteration: `pnpm run test:watch`.

## Rules the code must keep

- **No AI calls.** Never send a request to an AI model to produce anything the plugin shows (quota rows, toasts, command output); it would spend the user's tokens. Calling a provider's quota or billing API is fine.
- **OpenCode 2 only.** No OpenCode 1 code, APIs, or tables.
- **Server vs. TUI.** The server plugin (`src/plugin.ts`) reads providers, settings, and OpenCode's history, and registers the slash commands, the agent tools, and the `slkiser.opencode-quota` RPC. The TUI plugin (`src/tui/index.tsx`) only draws what the RPC returns and never imports provider or credential code. Web and Desktop get the slash commands only; OpenCode 2 has no plugin UI hooks there.
- **One status report.** `/quota_status`, the `quota_status` tool, and the RPC `status` method go through `buildQuotaDialogCommandOutput()`; `opencode-quota status` uses `buildStatusReportData()`, which that function wraps. Every value the report prints comes from a known list, a formatted number, or a placeholder (`tests/lib.quota-status.test.ts` checks this).
- **Credentials.** Read OpenCode logins only through `ctx.integration` in `src/lib/opencode-auth.ts`. The only exception is the terminal command (`src/lib/cli-show.ts`), which uses `src/lib/opencode-auth-sqlite.ts`; the plugins must never reach that file.
- **Money.** Use the shared formatter, which shows USD as `$12.50` and other currencies with an ISO code after the amount, such as `8.25 CNY`. Never convert amounts or add up different currencies.
- Keep these boundary tests passing and up to date: `tests/plugin.command-handled-boundary.test.ts`, `tests/tui-dist-import-graph.test.ts`, `tests/quota-provider-boundary.test.ts`, `tests/v6-cross-surface.test.ts`.

## Provider changes

**Built-in providers** are considered only when:

- the provider is on [models.dev](https://models.dev/),
- at least two independent users asked for it (your own request, repeat comments, and requests from the provider's own company don't count),
- it has a documented API (no login cookies or website scraping), and
- the PR links that evidence and explains why a custom provider isn't enough.

Even then, it needs a reasonable maintenance cost.

**Pick the right path:**

| You want to… | Use |
| --- | --- |
| Use an OpenAI-compatible model service OpenCode doesn't include | an OpenCode custom provider |
| Track quota for a provider OpenCode already exposes (request estimates or one fixed quota endpoint) | an OpenCode Quota custom provider ([ask your agent](../docs/readme/providers.md#custom-providers)); its `providerId` must match OpenCode's |
| Anything the custom path can't do, and the policy above is met | a built-in provider |

**Building one:** for API-key or token providers, start from `.github/provider-template/` (see its README), replace every example name, and add tests for every auth source. Use the setup label in `docs/readme/providers.md` that matches reality: `Automatic` or `Needs setup`.

**Every row** follows the row contract in `src/providers/contract.ts`. Pick `type` by what the number means (`quota`, `budget`, `usage`, `balance`, `status`), not by what's easiest to draw; `method` by how it was read (`remote_api`, `dashboard_scrape`, `local_cli`, `local_estimation`); and `authority` by who worked it out (`provider_reported` or `locally_derived`). A row's `key` is part of its id, which users' settings use, so it never changes once released.

Rich providers (more than a percentage) also:

- send numbers as typed `used`, `limit`, `remaining` or `amount` values and yes/no as `flag`; never pre-formatted money strings;
- set an explicit `primary` or `supplementary` prominence;
- keep `used`, `limit`, and `remaining` literal;
- keep labels short: the concept only, no values, units, or reset text.

A simple percentage-only provider may keep the plain percent row (`quotaRow`).

## Fixes

Make the smallest safe fix for the root cause. Match current OpenCode behavior instead of adding extra hook layers. Test against the current released OpenCode version and name it in the PR.

## Before-and-after screenshots (required)

Every PR that changes what users see must include before-and-after screenshots taken with the same config, model, theme, and window size, with credentials, account identifiers, and private paths hidden. Report each surface the change can reach: TUI sidebar (open and collapsed), the status line below the message input, toasts, the `/quota` window tabs (Usage, Limits, Plugin, and the Settings tabs), Web and Desktop text commands, and CLI `show`/`status`. For export, telemetry, or agent tools, paste the output before and after. Say which ones you didn't test. Tests don't replace screenshots, and screenshots don't replace tests. No visible change? Write `Not applicable` and why.

## PR checklist

- [ ] Linked issue, or a short reason there is none
- [ ] `pnpm verify` passes
- [ ] Tested on the current released OpenCode; version noted
- [ ] Before-and-after screenshots and surface results, or `Not applicable`
- [ ] Docs updated if commands, config, or workflow changed (usually `README.md`)
  Update the English docs only; the maintainer updates the translations in `docs/readme/i18n/`.
- [ ] New built-in provider: models.dev link, two independent requests, why custom isn't enough
- [ ] New API-key/token provider: started from the provider template, or explained why not
