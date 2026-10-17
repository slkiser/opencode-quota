# Token Watcher 3.11.0-rc.3

The application and package are now Token Watcher: `@thanhndv212/token-watcher`, command `token-watcher`, and macOS app `Token Watcher.app`. The previous `opencode-quota` command remains available as an alias. This prerelease continues the rc.2 feature set with a new name, TW icon and migration safeguards.

Existing settings, credentials, caches, history databases and the Electron profile retain their previous locations. No account data is copied for the rename. Existing plugin references are preserved with a migration warning; replace old package references manually in both OpenCode configuration files to switch. The safe macOS installation helper archives previous app bundles before replacement and retains user data. The new bundle identifier has separate macOS notification permissions; reset notifications remain opt-in.

Download desktop assets or install the attached runtime tarball locally. The new npm identity has not been published. The GitHub repository and previous release assets remain unchanged for continuity. Public desktop assets are unsigned; a local ad-hoc signature is not Developer ID signing or notarization.

Validation includes 1,677 tests, installed-tarball CLI/exports, Electron UI and profile isolation, cache isolation, native history compatibility and actual OpenCode command handling. The host smoke observes zero model requests; handled aborts still surface as HTTP 500. These checks do not certify live provider responses, interactive host integration or native notification delivery under the new application identity.

See the [rename and migration record](work-items/TOKEN_WATCHER_RENAME.md) for acceptance and rollback. Preserve private schema-migration backups when downgrading; an older writer must use the appropriate pre-upgrade database copy.
