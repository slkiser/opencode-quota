# Token Watcher identity and local macOS migration

Status: complete; published GitHub prerelease and locally installed macOS app accepted. Requested: 2026-10-17. Release: `3.11.0-rc.3`.

The user requested a full package/application rename to **Token Watcher**, following the published OpenCode Quota rc.2 release. Public identity becomes `@thanhndv212/token-watcher`, primary CLI `token-watcher`, desktop product `Token Watcher`, and bundle identifier `io.github.thanhndv212.tokenwatcher`. Linux executable and artifact names follow `token-watcher`; the macOS bundle is `Token Watcher.app`. Existing rc.1/rc.2 tags/assets remain immutable. The repository URL remains `thanhndv212/opencode-quota` for provenance and existing links.

## Compatibility

- The previous `opencode-quota` CLI remains an alias of the same deterministic implementation. Slash commands and export formats do not change.
- The installer recognizes both old fork/upstream package names and the renamed name. It preserves existing config entries and warns how to switch rather than installing a second quota plugin.
- Settings under `opencode-quota/quota-toast.json`, encrypted credentials, sync/cache/history files and their environment variables retain their existing namespaces. No credential or database files are copied for the rename.
- Electron explicitly retains `@thanhndv212/opencode-quota` under its application-data directory, preserving local storage and preferences. An explicit `--user-data-dir` overrides this compatibility location, including in isolated smokes.
- The shared handled-command symbol and existing TUI action keys retain legacy identities to preserve cross-version behavior; public server/TUI module IDs use the renamed package.
- The macOS installer refuses running apps or unrelated application identities, stages and verifies the replacement, creates CRC-verified rollback ZIPs for both named app locations, and restores moved apps if the replacement fails. It does not overwrite user config/history.

## Release and installation

The renamed npm identity was not found in the public registry during this run; this is not evidence of publisher rights or registry publication. Deliver through GitHub prerelease assets and a locally ad-hoc-signed macOS installation. Npm publishing remains a separate manual workflow. GitHub artifacts remain unsigned unless separately signed; local ad-hoc signing is not Developer ID signing, notarization or Gatekeeper certification. The new application identity may have distinct OS-managed permissions; do not automatically grant them.

The app icon uses a generated TW monogram and the README uses Token Watcher wordmarks. Upstream license/provenance and historical evidence retain their original names.

## Validation record

Local validation on 2026-10-17 passed: Node 22 typecheck; clean build; 162 test files / 1,677 tests; real installed tarball exports and renamed CLI; installed Electron 42.5.0 across all six tabs and refresh/history/budget boundaries; separate-process account/cache isolation; native Node history compatibility; actual OpenCode 1.18.10 deterministic command smoke (four ignored outputs, zero model requests). The host still reports handled aborts as HTTP 500, as previously recorded. The TW icon was visually inspected. The actual unsigned arm64 packaged macOS binary passed isolated startup, preload and all six tab checks without exceptions. [PR #62](https://github.com/thanhndv212/token-watcher/pull/62) merged at `5974d9e221b78161f42d6f930947cbec5e02694b`; [merged-main CI 39059331795](https://github.com/thanhndv212/token-watcher/actions/runs/39059331795) passed all six checks, including Node 20/22 tarball consumers and Linux/macOS Electron. Tag `v3.11.0-rc.3` points to that tested commit. [Tagged desktop build 39059504400](https://github.com/thanhndv212/token-watcher/actions/runs/39059504400) passed both platforms, including actual DMG/deb installation, preload/version and all six tab checks. All five runtime artifacts passed independent version/tag/commit/SHA256 checks, and their public GitHub asset digests match the originals. The [Token Watcher rc.3 prerelease](https://github.com/thanhndv212/token-watcher/releases/tag/v3.11.0-rc.3) is published; no npm publication occurred.

The exact Mac CI ZIP was unpacked separately, ad-hoc signed with hardened runtime and checked with `codesign --verify --deep --strict`. That signed copy passed isolated packaged-app checks. The running rc.2 app was stopped; the safe installer created and CRC-verified its rollback ZIP before installing `/Applications/Token Watcher.app`. Installed bundle/version and app.asar/renderer payload equality were verified; the old named application was removed only after backup. Computer Use observed the installed Token Watcher window, Dashboard and all six navigation tabs. The original Electron profile was present and remains the configured compatibility location. Private local source, smoke and rollback records remain under `release/local-token-watcher-3.11.0-rc.3/` and `release/install-backups/`; [public acceptance metadata](evidence/TOKEN-WATCHER-RC3-ACCEPTANCE.json) records the hashes and evidence limits.

AppImage-specific execution, live-provider responses, interactive host UI and native notification delivery under the renamed application identity remain unverified. The previous scoped rc.2 notification acceptance remains historical evidence only. The completed roadmap follow-up schedule remains paused. Meaningful migration coverage includes retaining the previous Electron profile, honoring an isolated profile, recognizing old plugin references without duplication, executing the primary renamed CLI from an installed tarball and validating the renamed package exports and renderer.

Rollback preserves the previous application ZIP. Keep active databases and their private schema-migration backups; downgrades must use an appropriate pre-upgrade copy rather than open a newer schema with an older writer.
