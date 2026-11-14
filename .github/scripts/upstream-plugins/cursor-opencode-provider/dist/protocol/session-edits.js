/**
 * Session rules that still deny edits after an agent switch.
 *
 * OpenCode evaluates session rules after the agent catalog; the last matching
 * rule wins. A plan-file allow does not lift a final `edit` deny on `*`, so
 * approving a plan cannot mean implementation is now permitted.
 */
/** Shared refusal clause for a mutation the session or this turn still forbids. */
export const SHELL_NOT_FOR_FILE_WRITES = "Do not create or change files through the shell.";
export const SESSION_PERMISSIONS_UNAVAILABLE_REASON = "OpenCode session permissions could not be read, so plan execution cannot be approved. "
    + "End this turn without implementing or writing files through the shell. Retry on a new user message.";
const FILE_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch"]);
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
/** OpenCode wildcard match: `*` and `?` in the rule, anchored to the whole input. */
function wildcardMatch(input, pattern) {
    const normalized = input.replaceAll("\\", "/");
    let escaped = pattern.replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".");
    if (escaped.endsWith(" .*"))
        escaped = escaped.slice(0, -3) + "( .*)?";
    return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}
/**
 * True when the last session rule whose action matches `edit` and whose
 * resource is `*` has effect `deny`. A later allow on only the plan path does
 * not count. A later `edit` `*` allow does.
 */
export function sessionRulesDenyEdits(permissions) {
    if (!Array.isArray(permissions))
        return false;
    let denied = false;
    for (const rule of permissions) {
        const record = asRecord(rule);
        if (!record)
            continue;
        // Native 1.x uses permission/pattern/action; 2.0 uses action/resource/effect.
        const classic = typeof record.permission === "string";
        const action = classic ? record.permission : record.action;
        const resource = classic ? record.pattern : record.resource;
        const effect = classic ? record.action : record.effect;
        if (resource !== "*")
            continue;
        if (effect !== "allow" && effect !== "deny" && effect !== "ask")
            continue;
        if (typeof action !== "string")
            continue;
        if (!wildcardMatch("edit", action))
            continue;
        denied = effect === "deny";
    }
    return denied;
}
/** Session payload from either entrypoint: a bare info object or `{ data }`. */
export function permissionsFromSession(session) {
    const record = asRecord(session);
    const info = asRecord(record?.data) ?? record;
    return info?.permissions ?? info?.permission;
}
/**
 * Read current permission evidence before a request can approve implementation.
 * Retry once for a transient host lookup failure. A failed read is not an empty
 * ruleset; classic SDK error responses may resolve instead of throwing.
 */
export async function loadSessionForPermissions(getSession) {
    const read = async () => {
        const session = await getSession();
        const response = asRecord(session);
        if (!response || response.error != null || ("data" in response && !asRecord(response.data))) {
            throw new Error("Could not read OpenCode session permissions");
        }
        return session;
    };
    try {
        return await read();
    }
    catch {
        return read();
    }
}
/**
 * Per conversation: the edit state of the last successfully written
 * request/continuation (`last`, absent when only restored from a snapshot),
 * and whether any deny reminder was ever written to it (`denySent`).
 */
const editGuidanceByConversation = new Map();
const MAX_EDIT_GUIDANCE_CONVERSATIONS = 256;
/**
 * Current edit guidance to send, or `undefined` when none is needed.
 * A deny is stated every time. The no-deny note only supersedes a deny Cursor
 * may hold: one this process sent, or, when this process has sent nothing to
 * the conversation, one inside a checkpoint that ever received a deny.
 * Carried notes may reintroduce an older deny regardless of what this process
 * last sent.
 */
export function sessionEditsGuidance(conversationId, denied, options) {
    if (denied === undefined)
        return undefined;
    if (denied)
        return true;
    if (options.carriesEditDeny)
        return false;
    const state = editGuidanceByConversation.get(conversationId);
    if (state?.last !== undefined)
        return state.last ? false : undefined;
    if (!options.carriesEarlierState)
        return undefined;
    // Unknown history (evicted, or never recorded nor restored) may hold a deny.
    return state && !state.denySent ? undefined : false;
}
/** Record only after the request or continuation carrying this state was written. */
export function recordSessionEditsGuidance(conversationId, denied) {
    if (denied === undefined)
        return;
    const denySent = denied || editGuidanceByConversation.get(conversationId)?.denySent === true;
    setEditGuidance(conversationId, { last: denied, denySent });
}
/** Snapshot value: an unknown conversation may hold a deny. */
export function sessionEditsDenySent(conversationId) {
    return editGuidanceByConversation.get(conversationId)?.denySent ?? true;
}
/**
 * Restart snapshot marker; live state recorded by this process wins, unless the snapshot is newer than it
 * (`replace`: another module copy wrote it after this copy last served the conversation).
 */
export function restoreSessionEditsDenySent(conversationId, denySent, replace = false) {
    if (!replace && editGuidanceByConversation.has(conversationId))
        return;
    setEditGuidance(conversationId, { denySent });
}
function setEditGuidance(conversationId, state) {
    editGuidanceByConversation.delete(conversationId);
    editGuidanceByConversation.set(conversationId, state);
    // An evicted conversation safely restates its current state on checkpoint reuse.
    if (editGuidanceByConversation.size > MAX_EDIT_GUIDANCE_CONVERSATIONS) {
        editGuidanceByConversation.delete(editGuidanceByConversation.keys().next().value);
    }
}
export function resetSessionEditsGuidanceForTests() {
    editGuidanceByConversation.clear();
}
export function notPermittedThisTurnReason(toolName, permittedToolNames) {
    const permitted = [...permittedToolNames].sort().join(", ");
    const shell = FILE_MUTATION_TOOLS.has(toolName) ? ` ${SHELL_NOT_FOR_FILE_WRITES}` : "";
    return `OpenCode tool '${toolName}' is not permitted for the current agent this turn. `
        + `Permitted tools: ${permitted || "none"}. Continue using only permitted tools; do not retry `
        + `'${toolName}'.${shell}`;
}
