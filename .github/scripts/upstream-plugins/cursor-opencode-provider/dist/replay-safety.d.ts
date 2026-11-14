import type { CursorProviderError } from "./errors.js";
export type ReplayBarrierReason = "visible-text" | "visible-reasoning" | "visible-tool-row" | "display-tool-lifecycle" | "non-control-exec" | "stateful-interaction" | "unknown-or-malformed-frame";
/**
 * A mid-turn `inject_context_action.user_context` this Run wrote: an OpenCode 2.x early steer or
 * host notes. Cursor answers a delivered one with `user_message_appended` echoing its `message_id`.
 */
export type RunInjection = {
    kind: "steer" | "note";
    injectionId: string;
    messageId: string;
    text: string;
    /** The raw host note bodies the text was built from. */
    notes?: string[];
    /** Cursor reported `context_injection_state` delivered. */
    delivered?: boolean;
};
/** One of the Run's own injections Cursor appended; a rebuild needs host history to hold it. */
export type AppendedInjection = {
    kind: "steer";
    injectionId: string;
} | {
    kind: "note";
    injectionId: string;
    notes: string[];
};
/** Remember an injection before writing it, so its echo can be recognized. */
export declare function trackRunInjection(injections: RunInjection[], injection: RunInjection): void;
export declare function markRunInjectionDelivered(injections: RunInjection[] | undefined, injectionId: string | undefined): void;
/**
 * The injection an appended message echoes: the same `message_id` and text, already delivered.
 * A match is consumed, so a second echo of the same message stays unmatched.
 */
export declare function takeAppendedInjection(injections: RunInjection[] | undefined, message: AppendedUserMessage | undefined): AppendedInjection | undefined;
/**
 * An exec the provider answered itself, so it has no host result. Each ran nothing on the host:
 * - `terminal-read`: a read of a host shell's terminal record (Cursor's AwaitShell polls);
 * - `missing-read`: the typed `file_not_found` / `invalid_file` of a read whose target is missing;
 * - `edit-handshake`: the empty read before an edit creates a new file;
 * - `task-attachment`: the placeholder read of a Task's attachment.
 * The last two are only complete with their call's host result: the edit's write, the Task.
 */
export type ProviderAnswer = "terminal-read" | "missing-read" | "edit-handshake" | "task-attachment";
/** Plain Run-owned state retained across host tool-step pump calls. */
export type ReplaySafetyState = {
    statefulBarrier?: ReplayBarrierReason;
    /**
     * Every exec needs its owner's host result; ids can restart on a resumed Run.
     * `callId` is the display call the exec claims. `answer` marks an exec the provider answered
     * itself (`ProviderAnswer`); history holds no result for it.
     */
    execs?: Array<{
        sessionId: string;
        id: number;
        callId?: string;
        answer?: ProviderAnswer;
    }>;
    /** Display calls Cursor announced; history holds one only through the host exec that claims it. */
    announcedCalls?: string[];
    /** Only strict inline catalog lookups qualify; spilled catalogs remain barriers. */
    catalogCalls?: Record<string, "started" | "completed">;
    /** History cannot represent opaque interactions, unknown frames or unclaimed display work. */
    historyRebaseUnsafe?: boolean;
    /**
     * Echoes of this Run's own steers and host notes. Each stays a stateful barrier, but a history
     * rebuild may proceed when the prompt it seeds holds every one (checked at rebuild time).
     */
    appendedInjections?: AppendedInjection[];
};
export type HistoryCoverage = {
    /** Execs that went to the host. */
    hostExecs: number;
    /** Provider answers by kind. */
    answers: Partial<Record<ProviderAnswer, number>>;
    /** Every host exec has its result in history, and every owned answer its call's host result. */
    complete: boolean;
};
/**
 * Whether host history holds everything the Run's execs did. `completed` holds
 * `sessionId:execId` of each host result in the prompt being rebuilt. A provider
 * answer needs no result of its own; an edit handshake or Task attachment read
 * needs a host exec of the same call whose result history holds.
 */
export declare function historyCoverage(state: ReplaySafetyState | undefined, completed: ReadonlySet<string>): HistoryCoverage;
/** Every display call must be represented by a host exec or a completed inline catalog lookup. */
export declare function announcedCallsClaimed(state: ReplaySafetyState | undefined): boolean;
export declare class AttemptReplaySafety {
    private readonly sessionId;
    private readonly state;
    private barrierReason;
    private stateful;
    /** A barrier of this attempt other than an echo of the Run's own injection. */
    private otherBarrier;
    constructor(sessionId: string, state?: ReplaySafetyState);
    markBarrier(reason: ReplayBarrierReason): void;
    /**
     * A display lifecycle frame. A started call stays a stateful barrier but
     * blocks a history rebuild only until a host exec claims it; completion of a
     * claimed call adds nothing history lacks. The sole server-side exception is
     * a completed inline catalog lookup: it has no execution side effect. Other
     * server-side calls and frames without a call id cannot be rebuilt.
     */
    recordToolLifecycle(lifecycle: ReplayToolLifecycle | undefined): void;
    recordExec(id: unknown, callId?: string): void;
    /** The provider answered this exec itself; nothing ran on the host. */
    recordProviderAnswer(id: number, answer: ProviderAnswer): void;
    /**
     * A `user_message_appended` update, with the Run's own injection it echoes. A stateful barrier
     * either way; only a matched echo leaves the history rebuild to the rebuild-time check.
     */
    recordAppendedMessage(injection: AppendedInjection | undefined): void;
    private markHistoryUnsafe;
    private mark;
    applyTo(failure: CursorProviderError): CursorProviderError;
}
export type DecodedReplayFrame = {
    interactionUpdate?: Record<string, unknown>;
    exec?: Record<string, unknown>;
    kv?: Record<string, unknown>;
    execControl?: Record<string, unknown>;
    interactionQuery?: Record<string, unknown>;
};
export type ReplayToolLifecycle = {
    kind: "started" | "completed";
    callId: string;
    catalog?: true;
};
export type AppendedUserMessage = {
    messageId: string;
    text: string;
};
export type ReplayFrameAnalysis = {
    barrier?: ReplayBarrierReason;
    /** Set for a well-formed lifecycle frame with a call id. */
    toolLifecycle?: ReplayToolLifecycle;
    /** Set for an appended message shaped like the echo of a client injection. */
    appendedUserMessage?: AppendedUserMessage;
};
/**
 * Field numbers and wire types of a frame, nested three levels, without any
 * payload bytes: `1:2{16:2{1:0}}`. Compare it with `agent.proto` when a frame
 * is classified unknown.
 */
export declare function describeFrameLayout(payload: Uint8Array, depth?: number): string;
/** Classify one decoded server frame without performing any protocol side effects. */
export declare function analyzeReplayFrame(payload: Uint8Array, decoded: DecodedReplayFrame): ReplayFrameAnalysis;
