## Setup

```bash
corepack enable
corepack prepare pnpm@10.0.0 --activate
pnpm install
```

`pnpm install` runs `prepare`, which installs Husky hooks. Use Node.js 22 for development/CI and pinned pnpm 10.0.0; the runtime package itself needs Node.js >=20.

## Build, Typecheck, Test

```bash
pnpm run typecheck        # tsc --noEmit
pnpm test                 # vitest run
pnpm run test:watch       # vitest (watch)
pnpm run build            # clean-dist → tsc → copy-data → prepare-tui-dist
pnpm run build:gui        # copies renderer HTML/CSS/JS into dist/gui/renderer/
pnpm run build:check      # clean build + real tarball consumer smoke
pnpm run smoke:gui        # actual Electron startup from an installed tarball
```

Build order matters — `copy-data` and `prepare-tui-dist` depend on `tsc` output.

## Linting / Formatting

Prettier only — no ESLint. Configuration: `semi: true`, `singleQuote: false`, `trailingComma: "all"`, `printWidth: 100`.

- `pnpm exec lint-staged` formats staged files (configured in `.lintstagedrc`).
- Pre-commit hooks run: lint-staged → typecheck → test.
- Pre-push hook: `pnpm install --frozen-lockfile`.

## Architecture

Three export paths from the same package:

| Export           | Entry                            | Config location | Purpose                                                                    |
| ---------------- | -------------------------------- | --------------- | -------------------------------------------------------------------------- |
| `.` / `./server` | `src/index.ts` → `src/plugin.ts` | `opencode.json` | Server plugin: slash commands, `tool.quota_status`, popup toasts           |
| `./tui`          | `src/tui.tsx`                    | `tui.json`      | TUI plugin: sidebar panel, compact status line, local dialogs, home bottom |
| `./gui`          | `src/gui/main.ts`                | N/A             | Standalone Electron desktop app                                            |

Both server and TUI plugins must be listed in their respective config files for full functionality. The TUI plugin renders with `@opentui/solid` (SolidJS JSX).

Key directories:

- `src/plugin.ts` — server plugin entry (hooks, toasts, slash command routing)
- `src/tui.tsx` — TUI plugin entry (sidebar, compact line, dialogs)
- `src/providers/` — one file per quota provider (22 providers), plus `registry.ts`
- `src/lib/` — internal libraries (config, auth, formatting, pricing, etc.)
- `src/bin/opencode-quota.ts` — CLI binary
- `src/gui/` — Electron menubar app
- `contributing/provider-template/` — template for adding new API-key providers

## Critical Invariants

### Slash commands are deterministic

All `/quota`, `/quota_status`, `/quota_announcements`, `/pricing_refresh`, `/tokens_*` commands must **never** invoke an LLM. They are dual-surface:

- **Server/web/desktop path**: Route through `buildQuotaDialogCommandOutput()` in `src/lib/quota-dialog-commands.ts`. Inject output via `injectRawOutput()` using `session.prompt({ noReply: true, parts: [{ type: "text", text, ignored: true }] })`. Must call `handled()` to stop OpenCode from continuing.
- **TUI dialog path**: Opens local dialogs via `api.keymap.registerLayer`. Must NOT call `session.prompt()`. Uses `(api as any).ui.dialog.replace()` for rendering.

### Command output injection

`injectRawOutput()` (defined in `src/plugin.ts`) is shared by server slash commands and `tool.quota_status`. Do NOT reuse it for TUI dialog output. The `ignored: true` flag keeps output out of model context while visible to users.

### Config location

Quota settings go in `opencode-quota/quota-toast.json` — NOT in `tui.json`. The config file lives next to `opencode.json` (project install) or in `~/.config/opencode/opencode-quota/` (global install). Legacy `experimental.quotaToast` in `opencode.json` is still read as fallback when no sidecar file exists.

### No model calls for output

Never invoke an LLM/model API to compute toast/report output. Everything is local, deterministic, and provider-quota-fetch only.

### Pricing

Model pricing snapshots come from `src/lib/modelsdev-pricing.ts`. Refresh with `/pricing_refresh` or `pnpm run pricing:refresh`. Pricing source config: `bundled` (packaged), `runtime` (fetched), or `auto`.

## Adding a New Provider

1. Copy files from `contributing/provider-template/` into `src/lib/<name>-config.ts`, `src/providers/<name>.ts`, and matching test files.
2. Add the provider to `src/lib/provider-metadata.ts`, `src/providers/registry.ts`, and `README.md`.
3. Use `Existing OpenCode auth, global config, or env` README wording **only after** tests prove all three auth paths work. Leave no copied template tests skipped.
4. Repo-local `opencode.json` secrets are ignored by design — use env vars or trusted user/global config.

## Test Files

Runs with `vitest` (Node environment). Test setup at `tests/setup.ts` resets pricing snapshot, timers, env stubs, and mocks after each test. Test file pattern: `tests/**/*.test.ts`.

Key boundary tests to keep passing:

- `tests/plugin.command-handled-boundary.test.ts`
- `tests/tui-smoke.test.ts`
- `tests/command-handled.test.ts`
- `tests/plugin.qwen-hook.test.ts`
- `tests/quota-provider-boundary.test.ts`

## Useful Commands

```bash
npx @thanhndv212/opencode-quota init      # Interactive installer
opencode-quota show                    # Terminal quota summary
opencode-quota show --json             # Machine-readable output
opencode-quota show --json --threshold 5  # CI gate (exit 1 if <5%)
opencode-quota gui                     # Launch Electron app from PATH
pnpm run pricing:refresh               # Fetch latest models.dev pricing
pnpm run build:package:mac             # Build macOS .dmg
pnpm run build:package:linux           # Build Linux .AppImage/.deb
pnpm run build:install:mac             # Build macOS .dmg + install to /Applications
pnpm run upstream:sync                 # Sync upstream plugin references
```

## Documentation

- Store project documentation under `docs/` by default, including plans, designs, implementation records and acceptance evidence. Keep standard repository entry points (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`) at the root.
- Store work-item designs and implementation records in `docs/work-items/`. State whether each item is planned, in progress or complete; preserve evidence dates, validation limits and rollback details.
- `docs/UPSTREAM_DELIVERY_PLAN.md` is authoritative for delivery status, dependencies and acceptance/release gates; `docs/UPSTREAM_ADOPTION.md` owns upstream provenance and capability mapping.
- Update `docs/README.md` and relative links when adding or moving documentation. Documentation under `docs/` is versioned by default.

## Conventions

- TypeScript strict mode, ESNext modules with bundler resolution, jsxImportSource: `@opentui/solid`.
- ESM everywhere (`"type": "module"` in package.json).
- `dist/` is build output, gitignored. Never edit files there.
- `references/` mostly gitignored except `references/upstream-plugins/`.
- Snapshots: not used. Tests use inline assertions.
- No CI services (Docker, databases) needed — tests run in pure Node.
- `better-sqlite3` is optional — token reports require it but quota display does not.
