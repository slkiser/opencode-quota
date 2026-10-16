/**
 * Parallel tool-call step boundary for OpenCode's AI SDK step model.
 *
 * Cursor fires execs as they are generated; CLI demuxes them concurrently and
 * has no step boundary. OpenCode needs one `finish: tool-calls` after every
 * call of the generation. Cursor's `tool_requests_listed` (InteractionUpdate
 * field 27) carries that count. See tasks/plans/parallel-tool-calls-cli-parity.md.
 */
/** Idle without a progress frame while holding → close the step (ms). */
export declare const PARALLEL_STEP_IDLE_MS = 1500;
export type ParallelStepState = {
    /** From field 27; undefined until Cursor lists the count for this step. */
    listedCount?: number;
    /** Model tool_call_ids seen this step. */
    callIds: Set<string>;
    /** Ids with a final client disposition this step. */
    resolved: Set<string>;
    /** Host tool-call parts emitted this step. */
    emitted: number;
    /** Wall time of the last progress frame (for the liveness guard). */
    lastProgressAt: number;
};
export declare function noteToolRequestsListedSeen(): void;
export declare function hasSeenToolRequestsListed(): boolean;
/** Test-only: reset the process capability gate. */
export declare function resetToolRequestsListedSeenForTests(): void;
export declare function createParallelStep(now?: number): ParallelStepState;
export declare function noteParallelStepProgress(step: ParallelStepState, now?: number): void;
export declare function noteListedCallCount(step: ParallelStepState, callCount: number, now?: number): void;
/**
 * Record a final disposition for `callId`. Returns true when newly resolved.
 * Empty ids are ignored. Prior-step ids in `prior` are ignored.
 */
export declare function resolveParallelStepCall(step: ParallelStepState, callId: string | undefined, prior?: ReadonlySet<string>, now?: number): boolean;
export declare function recordParallelStepEmission(step: ParallelStepState, now?: number): void;
/** True when the listed count is known and every listed call is resolved. */
export declare function parallelStepCountMet(step: ParallelStepState): boolean;
/**
 * Whether to keep pumping for more calls of this step instead of finishing.
 *
 * - Gate off and no count yet → do not hold (today's one-call finish).
 * - Human-gated interaction with unknown count → do not hold (prompt must show).
 * - Otherwise hold until the count is met (or the liveness guard fires).
 */
export declare function shouldHoldParallelStep(step: ParallelStepState, options?: {
    fieldSeen?: boolean;
    humanGatedWithoutCount?: boolean;
}): boolean;
/** True when the hold has made no progress for `idleMs`. */
export declare function shouldGuardCloseParallelStep(step: ParallelStepState, now?: number, idleMs?: number): boolean;
/**
 * Frames that reset the liveness guard while holding. Heartbeat, KV, and
 * checkpoint are not progress — they say nothing about further tool calls.
 */
export declare function isParallelStepProgressFrame(kinds: {
    toolRequestsListed?: boolean;
    partialToolCall?: boolean;
    toolCallDelta?: boolean;
    toolCallStarted?: boolean;
    toolCallCompleted?: boolean;
    exec?: boolean;
    interactionQuery?: boolean;
    textDelta?: boolean;
    thinkingDelta?: boolean;
}): boolean;
