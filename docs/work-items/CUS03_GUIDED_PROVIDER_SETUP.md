# CUS-03 — Guided provider setup

Issue: [#26](https://github.com/thanhndv212/opencode-quota/issues/26). Status: implemented; local acceptance passed; hosted checks and merge pending. Evidence date: 2026-10-15. Dependency: CUS-01 complete; local definitions use CUS-02.

Adapted from upstream provider-add capability at `2733b5bd010f659d1d6007e5d19026e82d51353f`, including the reviewed command/questionnaire and provider-add modules. Later history on release/4.x includes `338503d` formatting and `2a6b919` status integration. The fork deliberately uses an explicit definition file, complete changed-field preview and a separate digest-bound write command. It does not adopt a scoped updater or change host compatibility.

## Desktop and terminal setup

Create one definition JSON/JSONC file using the [remote schema/examples](CUS01_REMOTE_DEFINITIONS.md) or [local estimate example](CUS02_DURABLE_LOCAL_ESTIMATES.md). Credentials stay in the declared environment variable or existing trusted global provider/auth sources. No inline key fields, scripts or arbitrary headers are accepted.

```sh
opencode-quota provider add ./definition.json
# Review the complete quotaProviders before/after field and copy the printed SHA256.
opencode-quota provider add ./definition.json --write --expect <preview-sha256>
opencode-quota provider status
opencode-quota show --provider custom-example --details
```

Use the same terminal commands when configuring standalone Electron, then reload quota settings in the app. A full GUI editor remains optional. The command targets the primary trusted global opencode-quota/quota-toast.json sidecar, independent of the working directory. Alternate/legacy active definitions require moving the reviewed array to that primary sidecar first; the editor refuses to silently shadow them or discard their definitions. Malformed existing definitions also block writes.

Preview performs no config writes or quota/network requests. It displays the complete changed quotaProviders field; unrelated settings, which may contain credentials, are omitted and their bytes preserved. The digest binds the original file identity/content, target and proposed result. Any edited definition, changed config or retargeted symlink requires a new reviewed preview. The explicit --write and matching --expect are both required. Identical definitions are idempotent; a conflicting existing ID is refused rather than silently replaced.

The bounded JSONC token scanner changes only the declared array and necessary separator. It preserves comments, existing field/array bytes and unrelated settings without serializing the whole config. Duplicate root fields are rejected. Existing symlinks remain links: the resolved target is replaced atomically. Existing permission bits are preserved; new directories/files use 0700/0600, and rollback copies use 0600. Existing files must be user-owned regular files. Temporary files are created exclusively beside the target, synced and renamed after a final baseline check. A cooperative exclusive lock prevents concurrent editor writes; detected external edits abort. An uncooperative external writer can still race the final check/rename and must be coordinated normally. A crash can leave a lock: inspect the inactive process and recover its files before removing that lock; never remove an active writer's lock.

Existing files receive a byte-exact private before-provider-\*.bak copy. Precommit exceptions/race failures remove only this operation's temporary/backup files and preserve the original or concurrent editor's result. Once renamed, a directory-sync failure reports that the file was written with uncertain crash durability; it does not claim the write was rolled back.

## Acceptance and rollback

Validation covers local and remote schema reuse, JSONC comments/trailing commas/nested punctuation, unrelated secrets excluded from preview, explicit digest/write, idempotency/conflicts, file modes, symlink preservation, stale preview, held locks, edits immediately before rename, interrupted writes and byte-exact rollback copies. The installed tarball consumer exercises the actual CLI with isolated settings, previews without writing, performs the explicit write, checks comments/backup/idempotency/status and restores the original fixture. Provider status is local definition diagnosis only; it does not certify credentials or live endpoint correctness.

For rollback, close/co-ordinate settings writers, resolve the sidecar's existing symlink target, and restore the printed private copy to that target while retaining its permission bits. Preserve the link itself. Keep both files until the restored settings are loaded successfully. For a newly created sidecar, remove only the added quotaProviders field or the dedicated new file after confirming it has acquired no unrelated edits. Rollback tests recover isolated fixtures; no user settings are changed by development checks.

Node 22.23.3/pnpm 10.0.0: typecheck; 161 files / 1,671 tests; clean installed-tarball consumer including the actual provider editor CLI; account-cache process smoke; native Node/Bun 1.3.14 history compatibility; installed macOS Electron 42.5.0 smoke passed. Signed distribution, real host routing and visible OS notification delivery remain separate roadmap gates.
