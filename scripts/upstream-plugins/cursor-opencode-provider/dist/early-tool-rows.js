import { createHash } from "node:crypto";
/** Shown when an announced edit never becomes a host tool call. */
export const EARLY_ROW_CLOSED = "Cursor did not finish this tool call.";
/**
 * Shown when the announced call runs as a host tool the row did not predict,
 * such as a rewrite with unchanged content, which stays a `write`. The row's
 * tool name cannot change once started (OpenCode 2 rejects a renamed call),
 * so it completes and names the call that carries on.
 */
export function earlyRowHandoff(toolName) {
    return `Cursor continued this call as \`${toolName}\`.`;
}
const EARLY_ROW_PREFIX = "cursor-early_";
/**
 * Does not match `cursor_<session>_<execId>`. Continuation finds a bound row
 * through the session route table; a row that was closed never gets a route.
 * Cursor's call id is digested, not embedded: it can hold a newline and run to
 * ~90 characters, and the host keeps this id in history for every provider.
 */
export function earlyRowToolCallId(sessionId, cursorCallId) {
    const digest = createHash("sha256").update(cursorCallId).digest("hex").slice(0, 12);
    return `${EARLY_ROW_PREFIX}${sessionId}_${digest}`;
}
/** No exec has this id: the result is this provider's, but its exec is unknown. */
export const UNBOUND_EXEC_ID = -1;
/**
 * An early-row id whose route is gone (process restart, evicted route) still
 * belongs to this provider. Its result proves the Run lost a completed call,
 * so it must rebuild from host history like any other orphaned result.
 * The session id is a UUID, so it ends at the first underscore.
 */
export function parseEarlyRowToolCallId(toolCallId) {
    if (!toolCallId.startsWith(EARLY_ROW_PREFIX))
        return undefined;
    const rest = toolCallId.slice(EARLY_ROW_PREFIX.length);
    const separator = rest.indexOf("_");
    if (separator <= 0 || separator === rest.length - 1)
        return undefined;
    return { sessionId: rest.slice(0, separator), execId: UNBOUND_EXEC_ID };
}
/** Edit path from a `partial_tool_call`, once Cursor has included one. */
export function cursorEditAnnouncement(partial) {
    if (!partial || typeof partial !== "object")
        return undefined;
    const callId = partial.call_id;
    const toolCall = partial.tool_call;
    const edit = toolCall && typeof toolCall === "object"
        ? toolCall.edit_tool_call
        : undefined;
    const args = edit && typeof edit === "object" ? edit.args : undefined;
    const filePath = args && typeof args === "object" ? args.path : undefined;
    if (typeof callId !== "string" || callId.length === 0)
        return undefined;
    if (typeof filePath !== "string" || filePath.trim().length === 0)
        return undefined;
    return { callId, path: filePath };
}
/**
 * Open only while this step cannot end before the exec arrives. A parallel
 * step that is holding can take another row. Otherwise the step ends on the
 * first host call, so a row is useful only before any call or owed exec.
 */
export function shouldOpenEarlyRow(input) {
    if (!input.allowTools || input.hostInterrupted)
        return false;
    if (input.holdingParallelStep)
        return true;
    return input.emittedHostTools === 0 && input.owedPending === 0;
}
export class EarlyToolRows {
    open = new Map();
    skipped = new Set();
    seen(callId) {
        return this.open.has(callId) || this.skipped.has(callId);
    }
    openRow(row) {
        this.open.set(row.cursorCallId, row);
    }
    skip(callId) {
        this.skipped.add(callId);
    }
    claim(callId) {
        if (!callId)
            return undefined;
        const row = this.open.get(callId);
        if (!row)
            return undefined;
        this.open.delete(callId);
        return row;
    }
    drain() {
        const rows = [...this.open.values()];
        this.open.clear();
        return rows;
    }
}
