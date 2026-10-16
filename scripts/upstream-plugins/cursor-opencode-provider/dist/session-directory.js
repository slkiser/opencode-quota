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
import path from "node:path";
import { trace } from "./debug.js";
const MAX_TRACKED_SESSIONS = 256;
const sessionDirectories = new Map();
export function markSessionDirectory(sessionID, directory) {
    if (!sessionID || !directory)
        return;
    // Re-insert to keep insertion order meaningful for the eviction below.
    sessionDirectories.delete(sessionID);
    sessionDirectories.set(sessionID, directory);
    while (sessionDirectories.size > MAX_TRACKED_SESSIONS) {
        const oldest = sessionDirectories.keys().next().value;
        if (oldest === undefined)
            break;
        sessionDirectories.delete(oldest);
    }
}
export function getSessionDirectory(sessionID) {
    return typeof sessionID === "string" ? sessionDirectories.get(sessionID) : undefined;
}
export function clearSessionDirectories() {
    sessionDirectories.clear();
}
/**
 * Active session workspace directory from OpenCode 2.0 request headers.
 * Values may be URI-encoded.
 */
export function opencodeDirectoryHeader(headers) {
    if (!headers)
        return undefined;
    const raw = headers["x-opencode-directory"] ?? headers["X-Opencode-Directory"];
    if (typeof raw !== "string" || raw.trim().length === 0)
        return undefined;
    const trimmed = raw.trim();
    try {
        return decodeURIComponent(trimmed);
    }
    catch {
        return trimmed;
    }
}
/**
 * Resolve the workspace root for a model turn.
 * Prefer the per-request header, then the session mark, then static options/cwd.
 */
export function resolveSessionWorkspaceRoot(input) {
    const resolved = opencodeDirectoryHeader(input.headers) ?? getSessionDirectory(input.sessionKey);
    if (resolved)
        return path.resolve(resolved);
    const fallback = input.workspaceRoot || input.cwd || process.cwd();
    trace(`session directory: no header or session mark sessionKey=${input.sessionKey ?? "-"}; fallback=${fallback}`);
    return path.resolve(fallback);
}
