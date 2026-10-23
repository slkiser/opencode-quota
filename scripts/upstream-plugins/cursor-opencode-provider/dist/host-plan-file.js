/**
 * OpenCode's own plan file per session, resolved while the session runs under
 * the `plan` agent. CreatePlan records the plan there so the `plan_exit` review
 * reads exactly the file the user approves.
 *
 * Resolution is structural: session `slug` / `time.created` from the classic
 * client, project VCS and worktree from the plugin input, and the location
 * from OpenCode's `Session.plan` rule (or an injected host path bridge).
 */
import { hostPlanFilePath } from "./context/paths.js";
import { errorMessage, trace } from "./debug.js";
/** Session → its plan file, or `null` when the host defines none for it. */
const hostPlanFiles = new Map();
const MAX_HOST_PLAN_FILES = 256;
export function hostPlanFileFor(sessionID) {
    const key = sessionID?.trim();
    return (key ? hostPlanFiles.get(key) : undefined) ?? undefined;
}
/** True once the session's plan file is known, including known to be absent. */
export function isHostPlanFileResolved(sessionID) {
    const key = sessionID?.trim();
    return !!key && hostPlanFiles.has(key);
}
/**
 * Record a session's plan file. `null` records that the host defines none, so
 * it is not looked up again; `undefined` forgets it, so the next request retries.
 */
export function setHostPlanFile(sessionID, file) {
    const key = sessionID.trim();
    if (!key)
        return;
    hostPlanFiles.delete(key);
    if (file === undefined || file === "")
        return;
    hostPlanFiles.set(key, file);
    while (hostPlanFiles.size > MAX_HOST_PLAN_FILES) {
        const oldest = hostPlanFiles.keys().next().value;
        if (!oldest)
            break;
        hostPlanFiles.delete(oldest);
    }
}
export function resetHostPlanFilesForTests() {
    hostPlanFiles.clear();
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Resolve and remember the host plan file for one session. A session without
 * one is remembered as such; a failed lookup is not, so a later request retries.
 */
export async function resolveHostPlanFile(input) {
    try {
        const response = record(await input.getSession(input.sessionID));
        const info = record(response?.data) ?? response;
        const slug = typeof info?.slug === "string" ? info.slug : "";
        const created = record(info?.time)?.created;
        if (!slug || typeof created !== "number" || !input.worktree) {
            setHostPlanFile(input.sessionID, null);
            return undefined;
        }
        const file = hostPlanFilePath({ worktree: input.worktree, vcs: input.vcs, created, slug });
        setHostPlanFile(input.sessionID, file ?? null);
        if (file)
            trace(`host-plan-file: sessionID=${input.sessionID} file=${file}`);
        return file;
    }
    catch (error) {
        trace(`host-plan-file: unresolved sessionID=${input.sessionID} err=${errorMessage(error)}`);
        setHostPlanFile(input.sessionID, undefined);
        return undefined;
    }
}
