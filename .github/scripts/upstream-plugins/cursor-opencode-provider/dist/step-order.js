/**
 * Model-order holds for a Cursor step that changes a file.
 *
 * Cursor sends every exec of a step at once, and both OpenCode majors run a
 * step's tool calls concurrently, so a command the model wrote after an edit
 * can run before the edit lands. In a step with a file change (an edit, write
 * or delete, whichever host tool it becomes, including an edit's private
 * read), every later call in `tool_call_started` order waits until the file
 * change finishes, and the file change waits for the earlier calls that are
 * already running or held. A step without a file change runs as before.
 *
 * A held call reaches the host in a later host step. Nothing releases it on a
 * timer: only the file change's result (a failure included), Cursor's
 * completion or withdrawal of it, or this provider refusing it, as a failed
 * tool would under Cursor CLI. When the host refuses the file change (the user
 * denied it) or the user stops it, the calls that follow it are cancelled.
 */
/** Display calls that change a file. Cursor's `write` arrives as an `edit_tool_call`. */
const FILE_CHANGE_DISPLAY_VARIANTS = new Set([
    "edit_tool_call",
    "delete_tool_call",
    "pi_edit_tool_call",
    "pi_write_tool_call",
]);
/** Exec results of a file change (Cursor's side of the call). */
const FILE_CHANGE_RESULT_FIELDS = new Set([
    "write_result",
    "delete_result",
    "pi_edit_result",
    "pi_write_result",
]);
/** Canonical host file tools a Cursor call can be remapped to. */
const FILE_CHANGE_HOST_TOOLS = new Set(["edit", "write", "apply_patch", "patch"]);
export const HELD_CALL_CANCELLED_REASON = "Not run: it follows a file change in this step that was refused or interrupted. "
    + "Run it again only if it still applies.";
export function createStepOrder() {
    return { nextIndex: 0, calls: new Map(), execs: new Map(), held: [] };
}
/**
 * `mcpHostTool`: the host tool an `mcp_tool_call` announcement resolves to, as
 * its exec will. An advertised host `edit`/`write`/patch tool is announced as
 * an MCP call, and a later call's exec may arrive before its own.
 */
export function isFileChangeDisplay(toolCall, mcpHostTool) {
    if (!toolCall || typeof toolCall !== "object")
        return false;
    if (mcpHostTool !== undefined && FILE_CHANGE_HOST_TOOLS.has(mcpHostTool))
        return true;
    return Object.keys(toolCall).some((key) => FILE_CHANGE_DISPLAY_VARIANTS.has(key) && toolCall[key] != null);
}
export function isFileChangeExec(resultField, toolName) {
    return FILE_CHANGE_RESULT_FIELDS.has(resultField) || FILE_CHANGE_HOST_TOOLS.has(toolName);
}
const terminal = (state) => state === "done" || state === "refused";
function stepFinished(order) {
    return order.listedCount !== undefined
        && order.held.length === 0
        && order.calls.size >= order.listedCount
        && [...order.calls.values()].every((call) => terminal(call.state));
}
function clearStep(order) {
    order.calls.clear();
    order.execs.clear();
    order.nextIndex = 0;
    order.listedCount = undefined;
}
/** A new generation's count may precede its first tool announcement. */
export function noteOrderedCallCount(order, count) {
    if (!Number.isFinite(count) || count < 0)
        return;
    if (order.listedCount !== undefined && stepFinished(order))
        clearStep(order);
    order.listedCount = count;
}
/** Cursor explicitly started a new generation; outstanding holds retain their owner. */
export function startOrderedStep(order) {
    if (order && order.held.length === 0 && [...order.calls.values()].every((call) => terminal(call.state))) {
        clearStep(order);
    }
}
function ensureCall(order, callId, fileChange) {
    let call = order.calls.get(callId);
    if (!call) {
        call = { index: order.nextIndex++, fileChange, state: "announced" };
        order.calls.set(callId, call);
    }
    else if (fileChange) {
        call.fileChange = true;
    }
    return call;
}
/**
 * `tool_call_started`. A call after a finished generation starts a new one.
 * Keep a refusal until all listed calls have arrived, even when the idle
 * guard split the host step before Cursor sent the remaining calls. Without
 * a count, only an explicit new generation establishes that no calls remain.
 */
export function announceCall(order, callId, fileChange) {
    if (stepFinished(order))
        clearStep(order);
    ensureCall(order, callId, fileChange);
}
function blocked(order, callId, call) {
    for (const [otherId, other] of order.calls) {
        if (otherId === callId || other.index >= call.index)
            continue;
        // A started but unsent file change already blocks the calls after it.
        if (other.fileChange && (other.state === "announced" || other.state === "held" || other.state === "running"))
            return true;
        // A file change also waits for the earlier calls that are on their way.
        if (call.fileChange && (other.state === "held" || other.state === "running"))
            return true;
    }
    return false;
}
function followsRefusal(order, call) {
    for (const other of order.calls.values()) {
        if (other.index < call.index && other.fileChange && other.state === "refused")
            return true;
    }
    return false;
}
/** Decide an exec as it arrives: run it now, hold it, or cancel it behind a refused file change. */
export function orderExec(order, callId, fileChange) {
    const call = ensureCall(order, callId, fileChange);
    if (followsRefusal(order, call))
        return "cancel";
    return blocked(order, callId, call) ? "hold" : "run";
}
export function isFileChangeCall(order, callId) {
    return !!order?.calls.get(callId)?.fileChange;
}
export function holdExec(order, held) {
    const call = ensureCall(order, held.callId, false);
    call.state = "held";
    const at = order.held.findIndex((other) => (order.calls.get(other.callId)?.index ?? 0) > call.index);
    if (at < 0)
        order.held.push(held);
    else
        order.held.splice(at, 0, held);
}
/** An exec of `callId` was dispatched: answered here, refused, or sent to the host. */
export function runExec(order, callId, execId, fileChangeRead) {
    const call = ensureCall(order, callId, false);
    if (!terminal(call.state))
        call.state = "running";
    order.execs.set(execId, { callId, fileChangeRead });
}
/** The call finished: Cursor completed it, or it was answered without the host. */
export function finishCall(order, callId) {
    const call = order?.calls.get(callId);
    if (call && call.state !== "held" && call.state !== "refused")
        call.state = "done";
}
/** The host refused the call or the user stopped it. A refused file change cancels the calls after it. */
function refuseCall(order, callId) {
    const call = order?.calls.get(callId);
    if (!call || call.state === "held")
        return;
    call.state = call.fileChange ? "refused" : "done";
}
/**
 * A host result was delivered for `execId`. An edit's private read does not
 * finish its call: the write follows. A held exec is dropped (a fresh turn
 * cancelled it). Returns true when the order state changed.
 */
export function noteExecResult(order, execId, outcome) {
    if (!order)
        return false;
    if (dropHeldExec(order, execId))
        return true;
    const exec = order.execs.get(execId);
    if (!exec)
        return false;
    order.execs.delete(execId);
    if (outcome === "refused")
        refuseCall(order, exec.callId);
    else if (!exec.fileChangeRead)
        finishCall(order, exec.callId);
    return true;
}
/** Remove a held exec that will never run (Cursor withdrew it, or a result settled it). */
export function dropHeldExec(order, execId) {
    if (!order)
        return undefined;
    const at = order.held.findIndex((held) => held.execId === execId);
    if (at < 0)
        return undefined;
    const [held] = order.held.splice(at, 1);
    const call = order.calls.get(held.callId);
    if (call)
        call.state = "done";
    return held;
}
/** Held execs that follow a refused file change, in model order. */
export function takeCancelledExecs(order) {
    const cancelled = order.held.filter((held) => {
        const call = order.calls.get(held.callId);
        return !!call && followsRefusal(order, call);
    });
    for (const held of cancelled) {
        order.held.splice(order.held.indexOf(held), 1);
        const call = order.calls.get(held.callId);
        if (call)
            call.state = "done";
    }
    return cancelled;
}
/**
 * Held execs nothing blocks any more, in model order. A released file change
 * counts as running, so the calls after it stay held.
 */
export function takeReleasableExecs(order) {
    const released = [];
    for (const held of [...order.held]) {
        const call = order.calls.get(held.callId);
        if (!call || followsRefusal(order, call) || blocked(order, held.callId, call))
            continue;
        call.state = "running";
        order.held.splice(order.held.indexOf(held), 1);
        released.push(held);
    }
    return released;
}
