/**
 * Parallel tool-call step boundary for OpenCode's AI SDK step model.
 *
 * Cursor fires execs as they are generated; CLI demuxes them concurrently and
 * has no step boundary. OpenCode needs one `finish: tool-calls` after every
 * call of the generation. Cursor's `tool_requests_listed` (InteractionUpdate
 * field 27) carries that count. See tasks/plans/parallel-tool-calls-cli-parity.md.
 */
/** Idle without a progress frame while holding → close the step (ms). */
export const PARALLEL_STEP_IDLE_MS = 1_500;
/** Process-level: Cursor has sent field 27 on any Run in this process. */
let toolRequestsListedSeen = false;
export function noteToolRequestsListedSeen() {
    toolRequestsListedSeen = true;
}
export function hasSeenToolRequestsListed() {
    return toolRequestsListedSeen;
}
/** Test-only: reset the process capability gate. */
export function resetToolRequestsListedSeenForTests() {
    toolRequestsListedSeen = false;
}
export function createParallelStep(now = Date.now()) {
    return {
        callIds: new Set(),
        resolved: new Set(),
        emitted: 0,
        lastProgressAt: now,
    };
}
export function noteParallelStepProgress(step, now = Date.now()) {
    step.lastProgressAt = now;
}
export function noteListedCallCount(step, callCount, now = Date.now()) {
    noteToolRequestsListedSeen();
    if (Number.isFinite(callCount) && callCount >= 0) {
        step.listedCount = callCount;
    }
    noteParallelStepProgress(step, now);
}
/**
 * Record a final disposition for `callId`. Returns true when newly resolved.
 * Empty ids are ignored. Prior-step ids in `prior` are ignored.
 */
export function resolveParallelStepCall(step, callId, prior, now = Date.now()) {
    if (!callId)
        return false;
    if (prior?.has(callId))
        return false;
    step.callIds.add(callId);
    if (step.resolved.has(callId))
        return false;
    step.resolved.add(callId);
    noteParallelStepProgress(step, now);
    return true;
}
export function recordParallelStepEmission(step, now = Date.now()) {
    step.emitted++;
    noteParallelStepProgress(step, now);
}
/** True when the listed count is known and every listed call is resolved. */
export function parallelStepCountMet(step) {
    return step.listedCount !== undefined && step.resolved.size >= step.listedCount;
}
/**
 * Whether to keep pumping for more calls of this step instead of finishing.
 *
 * - Gate off and no count yet → do not hold (today's one-call finish).
 * - Human-gated interaction with unknown count → do not hold (prompt must show).
 * - Otherwise hold until the count is met (or the liveness guard fires).
 */
export function shouldHoldParallelStep(step, options = {}) {
    if (options.humanGatedWithoutCount && step.listedCount === undefined)
        return false;
    const fieldSeen = options.fieldSeen ?? hasSeenToolRequestsListed();
    if (!fieldSeen && step.listedCount === undefined)
        return false;
    if (parallelStepCountMet(step))
        return false;
    return true;
}
/** True when the hold has made no progress for `idleMs`. */
export function shouldGuardCloseParallelStep(step, now = Date.now(), idleMs = PARALLEL_STEP_IDLE_MS) {
    if (parallelStepCountMet(step))
        return false;
    return now - step.lastProgressAt >= idleMs;
}
/**
 * Frames that reset the liveness guard while holding. Heartbeat, KV, and
 * checkpoint are not progress — they say nothing about further tool calls.
 */
export function isParallelStepProgressFrame(kinds) {
    return !!(kinds.toolRequestsListed
        || kinds.partialToolCall
        || kinds.toolCallDelta
        || kinds.toolCallStarted
        || kinds.toolCallCompleted
        || kinds.exec
        || kinds.interactionQuery
        || kinds.textDelta
        || kinds.thinkingDelta);
}
