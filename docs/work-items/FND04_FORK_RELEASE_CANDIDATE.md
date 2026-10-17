# FND-04 — Fork release candidate and artifact promotion

Issue: [#7](https://github.com/thanhndv212/opencode-quota/issues/7). Status: complete for the draft artifact/identity gate; issue #7 and M0 closed. Evidence date: 2026-10-16. Candidate: `3.11.0-rc.1`. Version PR #57 merged at `b47c9df1b7a906ca42b0fd198c0a14b4283eb93c`; all six main CI 38961725242 checks passed before tag `v3.11.0-rc.1`. Distribution decision: **GitHub desktop/tarball candidate, without npm publication**. npm authentication is unavailable; no registry rights or package publication are claimed. Optional fork npm publication is manual-only and cannot be triggered by publishing a desktop GitHub release.

Package/repository/bugs/homepage/TUI imports/installer remain under `thanhndv212/opencode-quota`, preserving upstream MIT attribution. Linux maintainer metadata now identifies the fork maintainer's GitHub noreply identity rather than an upstream project address. There is no automatic version edit, protected-main push or upstream updater.

The candidate workflow verifies fork identity and, for a release tag, package-version/tag/commit agreement. It builds unsigned macOS DMG/ZIP and Linux AppImage/deb artifacts, mounts/extracts the actual DMG/deb payload into a temporary installation, and launches that binary with isolated settings/data. Preload, six tabs, package version and uncaught renderer exceptions are checked; screenshots/runtime evidence accompany provenance and SHA256 sums. Uninstall means removing that isolated copy/profile; no existing /Applications installation is overwritten. AppImage-specific execution is not inferred from a deb check. Unsigned build success is not signing, notarization or Gatekeeper approval.

## Runtime and compatibility evidence

- PASS: Node 20/22 installed npm tarball and macOS/Linux installed Electron CI through CUS-03; no source-tree fallback.
- PASS: actual installed OpenCode 1.18.10, isolated installed fork tarball, `/quota`, `/quota_status`, `/quota_dashboard`, and `/tokens_between` validation output. Four nonempty text outputs are stored with `ignored: true`; the local model trap endpoint receives zero requests. Source configuration and credentials are isolated; no real model API is invoked.
- LIMIT: OpenCode 1.18.10 exposes the plugin's handled abort as HTTP 500 after storing output. This is an observed host limitation, not an error-free web/TUI certification. The exact host command route triggers the plugin and then prompts unless the hook aborts: [official v1.18.10 source](https://github.com/anomalyco/opencode/blob/v1.18.10/packages/opencode/src/session/prompt.ts#L1460). The fixture boundary tests remain mandatory; removing `handled()` would violate no-model-call behavior.
- NOT_RUN: full interactive TUI command/dialog visual acceptance on this host.
- PASS (rc.2): exact Linux deb native X11/Dunst banner, persisted delivery and default-action History navigation; exact AppImage extract-and-run runtime. macOS banner/click observation remains blocked by unavailable Computer Use permission. INS-02 stays open.
- BLOCKED: live OpenRouter/Kilo validation because no configured credentials were available. Their issue contracts explicitly permit fixture-only completion with this limitation.
- NOT_RUN: signed/notarized distribution and real-user Gatekeeper acceptance; candidate artifacts are explicitly unsigned.

The reproducible host harness is `OPENCODE_HOST_BINARY=/path/to/opencode pnpm run smoke:host [tarball]`; it requires exact host version 1.18.10 by default (override only for an explicitly recorded additional version). The actual packaged-binary harness is `node scripts/smoke-packaged-app.mjs <installed-binary> <evidence-dir>`; it uses a temporary empty local usage database and no enabled quota providers. This verifies packaging/runtime integration, not live quotas.

## Upgrade and rollback

Quota settings remain in the existing sidecar; legacy settings are read as before. Schema v5 incorporates prior v2 accounting observations, v3 durable reset events, v4 delivery consumer leases and v5 custom local journals. Native upgrades retain consistent private SQLite backups and recheck schema under the writer lock. Preserve the active database plus all pre-migration backups. Older writers must not open a newer schema; restore a private copy of the appropriate pre-version backup into an isolated rollback profile, preserving the newer database for recovery. Native Node/Bun tests exercise upgrade, account/window isolation, dedup, backups, legacy/WASM reads and rollback copies.

Guided provider writes retain byte-exact private config backups; rollback preserves an existing sidecar symlink and restores its resolved target. Do not discard unrelated settings added after a backup. JSON-v1 exports and threshold semantics stay cache-only; local estimates are fetched by ordinary CLI/details and Electron, not fabricated into cache-only exports.

Local prerelease validation: Node 22.23.3/pnpm 10.0.0 typecheck, 161 files / 1,671 tests, clean installed consumer/editor CLI, account-cache smoke, native Node/Bun 1.3.14 history, installed Electron 42.5.0 and actual OpenCode 1.18.10 passed. The unsigned arm64 DMG was mounted read-only and copied to a temporary installation; its actual binary loaded all six tabs, correct version and preload without uncaught renderer exceptions. Inspected renderer captures show empty isolated history and functional Tokens/Alerts/Pricing/API Keys panels. Local build evidence precedes the reviewed tag and does not replace final CI artifact checks. There are zero valid local code-signing identities; no signing identity is assumed.

## Promotion record

2026-10-16: version PR #57 and all six main CI 38961725242 checks passed before annotated tag v3.11.0-rc.1 at b47c9df1b7a906ca42b0fd198c0a14b4283eb93c. Tagged desktop run 38962026363 passed macOS/Linux packaging and actual DMG/deb installation checks. The exact downloaded macOS ZIP also passed isolated installation/startup with six tabs, preload/version and no uncaught renderer exceptions. Candidate screenshots were inspected on both platforms.

The matching unsigned **draft prerelease** in [repository Releases](https://github.com/thanhndv212/opencode-quota/releases) contains the exact CI tarball, DMG/ZIP, AppImage/deb, per-platform checksums, provenance, manifest and installation evidence. All five binary/package SHA256 values independently match GitHub's server asset digests. GitHub normalizes spaces in asset names to dots: release checksum filenames match the normalized names; the [versioned manifest](evidence/FND04-CANDIDATE-MANIFEST.json) retains original CI names separately. No artifacts were rebuilt for upload. AppImage/FUSE execution remains unverified; packaging and deb execution do not certify it.

Issue #7's draft-release/metadata acceptance is complete and M0 is closed. This is not stable release promotion, signed/notarized distribution, live provider certification or whole-roadmap completion. Keep INS-02 and its remaining platform/action gates open; do not promote to stable or signed distribution from these limited candidate checks.

Candidate follow-up in PR #59: 3.11.0-rc.2 fixes the active-tab heading found by real Linux daemon acceptance. The OS action callback and selected window were correct; full renderer rebuilds reset the visible heading. Prepare/merge/test the new version before tagging and build/verify new exact artifacts. Preserve the rc.1 draft and its verified assets; never retag or silently rebuild the earlier candidate.

The rc.2 acceptance workflow also exercises the exact AppImage using its supported [extract-and-run fallback](https://docs.appimage.org/user-guide/troubleshooting/fuse.html), without changing host FUSE/security settings. A pass certifies that extraction/runtime path, not FUSE mounting or desktop integration. Results remain pending until the new artifact is built and exercised.

PR #59 merged at da2464424b4c06aec94e24ac8b1d2905dd3020c1; all six merged-main CI 38964213629 checks passed before annotated tag v3.11.0-rc.2. Its separate draft exists; exact tagged build 38964538508 passed both platforms. The exact merged-main rc.2 CI tarball also passed actual OpenCode 1.18.10 with four ignored outputs and zero model requests.

## rc.2 artifact acceptance — 2026-10-17

The exact downloaded ZIP passed isolated macOS installation/startup with six tabs, preload/version and no uncaught renderer exceptions. Tagged CI passed actual mounted-DMG and extracted-deb runtime checks. Native Linux acceptance 38964954082 passed actual X11/Dunst banner/action navigation and exact AppImage extract-and-run, with no mocked native callback. See the [notification record](INS02_NOTIFICATION_DELIVERY.md) for screenshot repaint and cleanup follow-up evidence and remaining macOS observation.

The separate unsigned draft contains exact rc.2 CI artifacts, checksums, provenance and installed-runtime evidence. The [rc.2 manifest](evidence/FND04-RC2-CANDIDATE-MANIFEST.json) preserves tag/commit identity and original CI filenames alongside GitHub-normalized names. No earlier tag or binary was replaced. All five binary/package SHA256 values independently match GitHub server asset digests; draft and prerelease flags were rechecked. This remains a draft, with macOS native observation and signed/stable promotion outside the evidence obtained.
