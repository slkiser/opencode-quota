import type { CursorProviderError } from "./errors.js";
export type ReplayBarrierReason = "visible-text" | "visible-reasoning" | "display-tool-lifecycle" | "non-control-exec" | "stateful-interaction" | "unknown-or-malformed-frame";
export declare class AttemptReplaySafety {
    private readonly sessionId;
    private barrierReason;
    constructor(sessionId: string);
    markBarrier(reason: ReplayBarrierReason): void;
    applyTo(failure: CursorProviderError): CursorProviderError;
}
export type DecodedReplayFrame = {
    interactionUpdate?: Record<string, unknown>;
    exec?: Record<string, unknown>;
    kv?: Record<string, unknown>;
    execControl?: Record<string, unknown>;
    interactionQuery?: Record<string, unknown>;
    checkpointBytes?: Uint8Array;
};
export type ReplayFrameAnalysis = {
    semanticProgress: boolean;
    barrier?: ReplayBarrierReason;
};
/**
 * Field numbers and wire types of a frame, nested three levels, without any
 * payload bytes: `1:2{16:2{1:0}}`. Compare it with `agent.proto` when a frame
 * is classified unknown.
 */
export declare function describeFrameLayout(payload: Uint8Array, depth?: number): string;
/** Classify one decoded server frame without performing any protocol side effects. */
export declare function analyzeReplayFrame(payload: Uint8Array, decoded: DecodedReplayFrame): ReplayFrameAnalysis;
