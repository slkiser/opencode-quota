/**
 * Session-scoped workspace directory for the OpenCode 2.0 plugin.
 *
 * The classic plugin learns the project directory from `input.directory`,
 * supplied once per invocation by the 1.x host. OpenCode 2.0 runs a single
 * daemon across many projects, so `process.cwd()` captured at sdk-creation
 * time is wrong for any session but the one open when the daemon started.
 *
 * The 2.0 runtime names a session directory in two places:
 * - request header `x-opencode-directory` (per-request; preferred in the LM).
 *   The host does not set it on model requests; the opencode2 plugin adds it
 *   from `session.hook("model.request")`, so it travels with the request
 *   instead of depending on this module's in-memory state.
 * - `ctx.session.get()` → `info.location.directory`, reachable from session
 *   hooks
 *
 * This module records the session-get value by id so the language model can
 * fall back when the header is absent, same mechanism as `compaction-marker.ts`.
 *
 * Bounded so a long-lived server cannot accumulate ids for dead sessions.
 */
export declare function markSessionDirectory(sessionID: string, directory: string | undefined): void;
export declare function getSessionDirectory(sessionID: string | undefined): string | undefined;
export declare function clearSessionDirectories(): void;
/**
 * Active session workspace directory from OpenCode 2.0 request headers.
 * Values may be URI-encoded.
 */
export declare function opencodeDirectoryHeader(headers: Record<string, string | undefined> | undefined): string | undefined;
/**
 * Resolve the workspace root for a model turn.
 * Prefer the per-request header, then the session mark, then static options/cwd.
 */
export declare function resolveSessionWorkspaceRoot(input: {
    sessionKey?: string;
    headers?: Record<string, string | undefined>;
    workspaceRoot?: string;
    cwd?: string;
}): string;
