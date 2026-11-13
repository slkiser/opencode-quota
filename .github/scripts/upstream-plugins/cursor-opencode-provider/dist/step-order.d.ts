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
export declare const HELD_CALL_CANCELLED_REASON: string;
/** `held`: its exec waits here; `refused`: a file change the host refused, which cancels later calls. */
export type OrderedCallState = "announced" | "held" | "running" | "done" | "refused";
export type OrderedCall = {
    /** Position in the model's order: `tool_call_started`, or exec arrival for an unannounced call. */
    index: number;
    fileChange: boolean;
    state: OrderedCallState;
};
export type HeldExec<F, P> = {
    callId: string;
    execId: number;
    /** The exec frame, dispatched again on release. */
    frame: F;
    /** What the frame asks for, to answer a cancelled call. */
    request: P;
    /** The pending entry that keeps the exec owed (heartbeats, fresh-turn cancel). */
    pending: unknown;
};
export type StepOrderState<F = unknown, P = unknown> = {
    nextIndex: number;
    /** Cursor's count for this generation, retained across host step splits. */
    listedCount?: number;
    calls: Map<string, OrderedCall>;
    /** Dispatched execs: which call each belongs to, and whether it is a file change's private read. */
    execs: Map<number, {
        callId: string;
        fileChangeRead: boolean;
    }>;
    /** Held execs in model order. */
    held: Array<HeldExec<F, P>>;
};
export declare function createStepOrder<F, P>(): StepOrderState<F, P>;
/**
 * `mcpHostTool`: the host tool an `mcp_tool_call` announcement resolves to, as
 * its exec will. An advertised host `edit`/`write`/patch tool is announced as
 * an MCP call, and a later call's exec may arrive before its own.
 */
export declare function isFileChangeDisplay(toolCall: unknown, mcpHostTool?: string): boolean;
export declare function isFileChangeExec(resultField: string, toolName: string): boolean;
/** A new generation's count may precede its first tool announcement. */
export declare function noteOrderedCallCount(order: StepOrderState, count: number): void;
/** Cursor explicitly started a new generation; outstanding holds retain their owner. */
export declare function startOrderedStep(order: StepOrderState | undefined): void;
/**
 * `tool_call_started`. A call after a finished generation starts a new one.
 * Keep a refusal until all listed calls have arrived, even when the idle
 * guard split the host step before Cursor sent the remaining calls. Without
 * a count, only an explicit new generation establishes that no calls remain.
 */
export declare function announceCall(order: StepOrderState, callId: string, fileChange: boolean): void;
/** Decide an exec as it arrives: run it now, hold it, or cancel it behind a refused file change. */
export declare function orderExec(order: StepOrderState, callId: string, fileChange: boolean): "run" | "hold" | "cancel";
export declare function isFileChangeCall(order: StepOrderState | undefined, callId: string): boolean;
export declare function holdExec<F, P>(order: StepOrderState<F, P>, held: HeldExec<F, P>): void;
/** An exec of `callId` was dispatched: answered here, refused, or sent to the host. */
export declare function runExec(order: StepOrderState, callId: string, execId: number, fileChangeRead: boolean): void;
/** The call finished: Cursor completed it, or it was answered without the host. */
export declare function finishCall(order: StepOrderState | undefined, callId: string): void;
/**
 * A host result was delivered for `execId`. An edit's private read does not
 * finish its call: the write follows. A held exec is dropped (a fresh turn
 * cancelled it). Returns true when the order state changed.
 */
export declare function noteExecResult(order: StepOrderState | undefined, execId: number, outcome: "done" | "refused"): boolean;
/** Remove a held exec that will never run (Cursor withdrew it, or a result settled it). */
export declare function dropHeldExec<F, P>(order: StepOrderState<F, P> | undefined, execId: number): HeldExec<F, P> | undefined;
/** Held execs that follow a refused file change, in model order. */
export declare function takeCancelledExecs<F, P>(order: StepOrderState<F, P>): Array<HeldExec<F, P>>;
/**
 * Held execs nothing blocks any more, in model order. A released file change
 * counts as running, so the calls after it stay held.
 */
export declare function takeReleasableExecs<F, P>(order: StepOrderState<F, P>): Array<HeldExec<F, P>>;
