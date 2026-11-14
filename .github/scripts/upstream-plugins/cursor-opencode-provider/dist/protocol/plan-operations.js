/**
 * Bounded CreatePlan write/review receipts for restart reconciliation.
 *
 * A saved file alone proves neither tool completion nor execution approval.
 * Incomplete operations fail closed; a new user turn is required.
 */
import { trace } from "../debug.js";
import { processShared } from "../process-shared.js";
const MAX_RECEIPTS = 8;
const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_SESSIONS = 64;
const state = processShared("plan-operations.v1", () => ({ bySession: new Map() }));
function markdownBytes(receipts) {
    let total = 0;
    for (const receipt of receipts)
        total += Buffer.byteLength(receipt.markdown, "utf8");
    return total;
}
function touch(sessionKey) {
    const existing = state.bySession.get(sessionKey);
    if (existing) {
        state.bySession.delete(sessionKey);
        state.bySession.set(sessionKey, existing);
        return existing;
    }
    const created = [];
    state.bySession.set(sessionKey, created);
    return created;
}
/** Refuse before mutation when the receipt budget is full. */
export function canAdmitPlanOperation(sessionKey, markdown) {
    if (!sessionKey)
        return { ok: true };
    if (!state.bySession.has(sessionKey) && state.bySession.size >= MAX_SESSIONS) {
        return { ok: false, error: "CreatePlan operation budget is full; finish pending plans first" };
    }
    const receipts = state.bySession.get(sessionKey) ?? [];
    if (receipts.length >= MAX_RECEIPTS) {
        return { ok: false, error: "CreatePlan operation budget is full; start a new turn" };
    }
    const next = markdownBytes(receipts) + Buffer.byteLength(markdown, "utf8");
    if (next > MAX_MARKDOWN_BYTES) {
        return { ok: false, error: "CreatePlan operation budget is full; start a new turn" };
    }
    return { ok: true };
}
export function recordPlanOperation(sessionKey, receipt) {
    if (!sessionKey)
        return { ok: true };
    const admitted = canAdmitPlanOperation(sessionKey, receipt.markdown);
    if (!admitted.ok)
        return admitted;
    const list = touch(sessionKey);
    list.push(receipt);
    return { ok: true };
}
export function updatePlanOperationConsumed(sessionKey, hostCallId, consumedResultId, phase) {
    if (!sessionKey)
        return;
    const list = state.bySession.get(sessionKey);
    if (!list)
        return;
    const receipt = list.find((entry) => entry.hostCallId === hostCallId && !entry.consumedResultId);
    if (receipt) {
        receipt.consumedResultId = consumedResultId;
        if (phase)
            receipt.phase = phase;
    }
}
export function clearPlanOperation(sessionKey, hostCallId) {
    if (!sessionKey)
        return;
    const list = state.bySession.get(sessionKey);
    if (!list)
        return;
    const next = list.filter((entry) => entry.hostCallId !== hostCallId);
    if (next.length === 0)
        state.bySession.delete(sessionKey);
    else
        state.bySession.set(sessionKey, next);
}
export function clearPlanOperations(sessionKey) {
    if (sessionKey)
        state.bySession.delete(sessionKey);
}
export function planOperationsFor(sessionKey) {
    if (!sessionKey)
        return [];
    return state.bySession.get(sessionKey) ?? [];
}
/** Incomplete write/review after restart: fail closed; do not auto-replay mutation. */
export function incompletePlanOperations(sessionKey) {
    return planOperationsFor(sessionKey).filter((receipt) => receipt.phase === "review" || !receipt.consumedResultId);
}
export function serializePlanOperations(sessionKey) {
    const receipts = state.bySession.get(sessionKey);
    return receipts?.length ? JSON.stringify({ version: 1, receipts }) : undefined;
}
export function restorePlanOperations(sessionKey, encoded) {
    // Admission limits must not erase durable evidence of an unfinished write.
    if (!encoded || state.bySession.has(sessionKey))
        return;
    let value;
    try {
        value = JSON.parse(encoded);
    }
    catch {
        return;
    }
    if (!value || value.version !== 1 || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) {
        return;
    }
    const receipts = [];
    let bytes = 0;
    for (const entry of value.receipts) {
        if (!entry || typeof entry !== "object")
            return;
        const receipt = entry;
        if (typeof receipt.interactionId !== "number"
            || typeof receipt.hostCallId !== "string"
            || typeof receipt.planPath !== "string"
            || typeof receipt.planUri !== "string"
            || typeof receipt.markdown !== "string"
            || (receipt.phase !== "write" && receipt.phase !== "review")
            || typeof receipt.bridgeKind !== "string") {
            return;
        }
        bytes += Buffer.byteLength(receipt.markdown, "utf8");
        if (bytes > MAX_MARKDOWN_BYTES)
            return;
        receipts.push({
            interactionId: receipt.interactionId,
            hostCallId: receipt.hostCallId,
            planPath: receipt.planPath,
            planUri: receipt.planUri,
            markdown: receipt.markdown,
            phase: receipt.phase,
            bridgeKind: receipt.bridgeKind,
            ...(typeof receipt.createPlanToolCallId === "string"
                ? { createPlanToolCallId: receipt.createPlanToolCallId }
                : {}),
            ...(receipt.afterWrite === "review" || receipt.afterWrite === "ack" || receipt.afterWrite === "hold"
                ? { afterWrite: receipt.afterWrite }
                : {}),
            ...(receipt.reviewToolName === "plan_exit" || receipt.reviewToolName === "question"
                ? { reviewToolName: receipt.reviewToolName }
                : {}),
            ...(typeof receipt.consumedResultId === "string"
                ? { consumedResultId: receipt.consumedResultId }
                : {}),
        });
    }
    if (receipts.length) {
        state.bySession.set(sessionKey, receipts);
        trace(`plan operations: restored sessionKey=${sessionKey} count=${receipts.length}`);
    }
}
export function resetPlanOperationsForTests() {
    state.bySession.clear();
}
