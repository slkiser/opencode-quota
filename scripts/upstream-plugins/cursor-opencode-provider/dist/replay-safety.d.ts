import type { CursorProviderError } from "./errors.js";
export type ReplayBarrierReason = "visible-text" | "visible-reasoning" | "visible-tool-row" | "display-tool-lifecycle" | "non-control-exec" | "stateful-interaction" | "unknown-or-malformed-frame";
/** Plain Run-owned state retained across host tool-step pump calls. */
export type ReplaySafetyState = {
    statefulBarrier?: ReplayBarrierReason;
    /** Every exec needs its owner's host result; ids can restart on a resumed Run. */
    execs?: Array<{
        sessionId: string;
        id: number;
    }>;
    /** History cannot represent opaque interactions, unknown frames or started display work. */
    historyRebaseUnsafe?: boolean;
};
export declare class AttemptReplaySafety {
    private readonly sessionId;
    private readonly state;
    private barrierReason;
    private stateful;
    constructor(sessionId: string, state?: ReplaySafetyState);
    markBarrier(reason: ReplayBarrierReason): void;
    recordExec(id: unknown): void;
    applyTo(failure: CursorProviderError): CursorProviderError;
}
export type DecodedReplayFrame = {
    interactionUpdate?: Record<string, unknown>;
    exec?: Record<string, unknown>;
    kv?: Record<string, unknown>;
    execControl?: Record<string, unknown>;
    interactionQuery?: Record<string, unknown>;
};
export type ReplayFrameAnalysis = {
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
