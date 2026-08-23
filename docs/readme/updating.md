[← Back to README](../../README.md)

# Updating safely

## What the command does

`npx @slkiser/opencode-quota@latest update` first asks npm to resolve and run the published `@latest` CLI package. That npm resolution and execution begins before the updater can print its preview. The preview guarantee covers changes owned by the updater: OpenCode configuration files and OpenCode Quota package-cache directories.

The updater builds one plan, prints it in full, and then either stops or applies that same plan. It does not add runtime compatibility fallbacks.

## Preview, apply, and restart

1. Close OpenCode.
2. Preview without changing configuration or package caches:

   ```bash
   npx @slkiser/opencode-quota@latest update --dry-run
   ```

3. Read every section. If the plan is correct, apply it:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

   The interactive command asks once before safe work begins. For a noninteractive run, use:

   ```bash
   npx @slkiser/opencode-quota@latest update --yes
   ```

   `--yes` still prints the full preview. It authorizes only deterministic config edits and manifest-verified cache cleanup, never secret changes.

4. Restart OpenCode.
5. Run `/quota_status` in OpenCode, or run this in a terminal:

   ```bash
   opencode-quota status
   ```

## Read the preview

The preview can contain three sections:

- **Safe changes this command can make:** package-spec edits and recognized file-backed display-setting migration.
- **Manual actions — this command will not change these sources:** credential findings or config cases that require your review.
- **Package-cache candidates:** directories considered for removal. A candidate is removed only after current config and the package manifest are verified.

Empty sections are omitted. No updater-owned config or cache change happens before the preview and, for the interactive command, your confirmation.

The command uses two exit codes:

- `0`: applied, already current, successful dry-run, manual-only findings, or cancellation.
- `1`: invalid arguments, incomplete planning, a config race, a write failure, or post-write validation failure.

Manual findings do not make the command fail. They remain your responsibility.

## What can change automatically

The updater can:

- change supported OpenCode Quota plugin package specs to `@latest`;
- remove only package-cache directories that pass path, symlink, containment, and exact package-manifest checks;
- migrate recognized `opencodeZenDisplay` values in known file-backed quota config locations:
  - `"default"` becomes root `accountingDetail: "summary"`;
  - `"detailed"` becomes root `accountingDetail: "detailed"`;
- keep an existing valid `accountingDetail` value and remove the obsolete ignored key, even when the two values differ.

Targeted JSON/JSONC edits preserve unrelated settings, plugins, comments, trailing commas, and tuple options where the document can be edited safely.

Unsupported or invalid display values, invalid replacement values, duplicate keys, ambiguous structures, malformed files, unsupported roots, and newly discovered symlinks are left unchanged for manual review. SDK-only config is diagnostic-only because it has no safe file path for the updater to edit.

## What stays manual

Credential findings are report-only. The audit detects known obsolete sources by variable-name or file-path presence without retrieving environment values or opening credential files. It never prints, copies, or deletes secret values, and it does not edit environment declarations, shell startup files, `auth.json`, supported credential files, or legacy credential files.

### OpenCode Go findings

OpenCode Go now uses an official API key. Configure one supported source in this order:

1. `OPENCODE_API_KEY`
2. Trusted user/global OpenCode config: `provider.opencode-go.options.apiKey`
3. Trusted user/global fallback: `provider.opencode.options.apiKey`
4. A strict `opencode-go` API-key entry in OpenCode `auth.json`
5. A strict legacy `opencode` API-key entry in `auth.json` as the final fallback

You can create the canonical `auth.json` entry with:

```bash
opencode auth login -p opencode-go
```

Verify the supported key with `/quota_status` or terminal `opencode-quota status`. Only after it works, manually remove obsolete declarations for `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE`, plus any obsolete global `opencode-quota/opencode-go.json` file.

Workspace/cookie material cannot be converted into the official API key. Do not paste credential values into command output, issue reports, or support messages.

### OpenCode Zen findings

`OPENCODE_WORKSPACE_ID` and `OPENCODE_AUTH_COOKIE` are ambiguous names: they may come from an older Zen setup, but they may instead belong to OpenCode's workspace feature. Current quota code ignores them. The updater reports them only when it finds no supported global `opencode-quota/opencode.json` path, and it does not read or move their values.

First decide whether those variables really contain Zen credentials. If they do, create the supported file under your global OpenCode config directory. The usual path is `~/.config/opencode/opencode-quota/opencode.json`:

```json
{
  "workspaceId": "your-workspace-id",
  "authCookie": "your-auth-cookie"
}
```

Use placeholders while documenting or sharing the setup; never share the real values. Restrict file access to your user account, verify with `/quota_status` or terminal `opencode-quota status`, and only then remove obsolete environment declarations manually. If the variables belong to OpenCode's workspace feature, leave them with that feature instead of treating them as Zen credentials.

## Cancellation, failures, and reruns

Before updating, back up the OpenCode config files you use. This is especially important if you may roll back to an older plugin version, because old versions do not understand every current setting.

Cancelling the interactive prompt changes nothing. Dry-run also changes nothing. A successful migration is idempotent: rerunning does not repeat a completed display edit, though manual findings remain until you resolve their sources.

The updater checks every planned file again before writing and writes each changed file atomically. It does not claim that several files form one transaction and it does not overwrite concurrent edits with an automatic rollback. If a later file changes or a write fails after earlier files were written, the error lists the files changed before failure and deletes no package cache. Fix the reported cause, inspect those paths, and rerun the dry-run command to build a fresh plan.
