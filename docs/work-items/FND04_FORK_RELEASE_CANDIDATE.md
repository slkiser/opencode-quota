# FND-04 — Fork release candidate and artifact promotion

Issue: [#7](https://github.com/thanhndv212/opencode-quota/issues/7). Status: in progress. Evidence date: 2026-10-15. Candidate: `3.11.0-rc.1`. Version PR #57 merged at `b47c9df1b7a906ca42b0fd198c0a14b4283eb93c`; all six main CI 38961725242 checks passed before tag `v3.11.0-rc.1`. Distribution decision: **GitHub desktop/tarball candidate, without npm publication**. npm authentication is unavailable; no registry rights or package publication are claimed. Optional fork npm publication is manual-only and cannot be triggered by publishing a desktop GitHub release.

Package/repository/bugs/homepage/TUI imports/installer remain under `thanhndv212/opencode-quota`, preserving upstream MIT attribution. Linux maintainer metadata now identifies the fork maintainer's GitHub noreply identity rather than an upstream project address. There is no automatic version edit, protected-main push or upstream updater.

The candidate workflow verifies fork identity and, for a release tag, package-version/tag/commit agreement. It builds unsigned macOS DMG/ZIP and Linux AppImage/deb artifacts, mounts/extracts the actual DMG/deb payload into a temporary installation, and launches that binary with isolated settings/data. Preload, six tabs, package version and uncaught renderer exceptions are checked; screenshots/runtime evidence accompany provenance and SHA256 sums. Uninstall means removing that isolated copy/profile; no existing /Applications installation is overwritten. AppImage-specific execution is not inferred from a deb check. Unsigned build success is not signing, notarization or Gatekeeper approval.

## Runtime and compatibility evidence

- PASS: Node 20/22 installed npm tarball and macOS/Linux installed Electron CI through CUS-03; no source-tree fallback.
- PASS: actual installed OpenCode 1.18.10, isolated installed fork tarball, `/quota`, `/quota_status`, `/quota_dashboard`, and `/tokens_between` validation output. Four nonempty text outputs are stored with `ignored: true`; the local model trap endpoint receives zero requests. Source configuration and credentials are isolated; no real model API is invoked.
- LIMIT: OpenCode 1.18.10 exposes the plugin's handled abort as HTTP 500 after storing output. This is an observed host limitation, not an error-free web/TUI certification. The exact host command route triggers the plugin and then prompts unless the hook aborts: [official v1.18.10 source](https://github.com/anomalyco/opencode/blob/v1.18.10/packages/opencode/src/session/prompt.ts#L1460). The fixture boundary tests remain mandatory; removing `handled()` would violate no-model-call behavior.
- NOT_RUN: full interactive TUI command/dialog visual acceptance on this host.
- BLOCKED: observed macOS and Linux notification banner/click delivery under INS-02; mocked callbacks and show acknowledgements do not meet this gate.
- BLOCKED: live OpenRouter/Kilo validation because no configured credentials were available. Their issue contracts explicitly permit fixture-only completion with this limitation.
- NOT_RUN: signed/notarized distribution and real-user Gatekeeper acceptance; candidate artifacts are explicitly unsigned.

The reproducible host harness is `OPENCODE_HOST_BINARY=/path/to/opencode pnpm run smoke:host [tarball]`; it requires exact host version 1.18.10 by default (override only for an explicitly recorded additional version). The actual packaged-binary harness is `node scripts/smoke-packaged-app.mjs <installed-binary> <evidence-dir>`; it uses a temporary empty local usage database and no enabled quota providers. This verifies packaging/runtime integration, not live quotas.

## Upgrade and rollback

Quota settings remain in the existing sidecar; legacy settings are read as before. Schema v5 incorporates prior v2 accounting observations, v3 durable reset events, v4 delivery consumer leases and v5 custom local journals. Native upgrades retain consistent private SQLite backups and recheck schema under the writer lock. Preserve the active database plus all pre-migration backups. Older writers must not open a newer schema; restore a private copy of the appropriate pre-version backup into an isolated rollback profile, preserving the newer database for recovery. Native Node/Bun tests exercise upgrade, account/window isolation, dedup, backups, legacy/WASM reads and rollback copies.

Guided provider writes retain byte-exact private config backups; rollback preserves an existing sidecar symlink and restores its resolved target. Do not discard unrelated settings added after a backup. JSON-v1 exports and threshold semantics stay cache-only; local estimates are fetched by ordinary CLI/details and Electron, not fabricated into cache-only exports.

Local prerelease validation: Node 22.23.3/pnpm 10.0.0 typecheck, 161 files / 1,671 tests, clean installed consumer/editor CLI, account-cache smoke, native Node/Bun 1.3.14 history, installed Electron 42.5.0 and actual OpenCode 1.18.10 passed. The unsigned arm64 DMG was mounted read-only and copied to a temporary installation; its actual binary loaded all six tabs, correct version and preload without uncaught renderer exceptions. Inspected renderer captures show empty isolated history and functional Tokens/Alerts/Pricing/API Keys panels. Local build evidence precedes the reviewed tag and does not replace final CI artifact checks. There are zero valid local code-signing identities; no signing identity is assumed.

## Promotion record

2026-10-16: version PR and main CI complete; annotated tag points to the tested merged commit. The matching draft prerelease exists. Tagged desktop candidate run 38962026363 is building the exact assets. Pending: verify its installed-artifact checks/checksums/metadata and attach the tested package plus desktop binaries/provenance to the **draft prerelease**. Keep external release/OS gates explicit. Do not promote to a stable or signed release while those gates are unverified.
