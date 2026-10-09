import type { BidiStream } from "./transport/connect.js";
import { type CursorProviderError } from "./errors.js";
import { type SessionActivitySource } from "./activity.js";
import type { HostSubagentCatalog, HostToolDialect, OpencodeToolDef, ToolAliasRegistry } from "./protocol/tools.js";
import type { CursorConversationTokenDetails } from "./protocol/token-details.js";
import type { ParallelStepState } from "./parallel-step.js";
export type Frame = {
    flags: number;
    payload: Uint8Array;
};
export type CursorContinuationOptions = {
    semanticIdleMs?: number;
    /** @deprecated Use semanticIdleMs. Kept as a strict alias for compatibility. */
    softHealthMs?: number;
    /** Pending-tool inactivity window, renewed by OpenCode session progress. */
    hardCapMs?: number;
    heartbeatMs?: number;
};
export type CursorContinuationPolicy = {
    semanticIdleMs: number;
    hardCapMs: number;
    heartbeatMs: number;
};
export declare const DEFAULT_CONTINUATION_POLICY: Readonly<CursorContinuationPolicy>;
export declare function resolveContinuationPolicy(options: CursorContinuationOptions | undefined): CursorContinuationPolicy;
export type PendingExecState = "pending" | "claimed" | "delivered";
/**
 * A held-open Run stream. Cursor drives the agentic loop server-side and
 * expects tool results on the SAME bidi stream. opencode, by contrast, owns
 * its tool loop: it calls `doStream`, gets a tool-call, executes it, then calls
 * `doStream` again with the result. We bridge the two by keeping the Run stream
 * (and its single frames iterator) alive in a session across `doStream` calls,
 * keyed by the exec ids we are waiting results for.
 */
export type PendingExec = {
    /** ExecClientMessage result field to reply with (matches the request variant). */
    resultField: string;
    state: PendingExecState;
    registeredAt: number;
    hardDeadlineAt: number;
    /**
     * Resolved opencode tool name (read/write/grep/…). Used on continuation so
     * mcp_result can unwrap read envelopes even if the prompt omits toolName.
     */
    toolName?: string;
    /** Original request fields required by a typed result message. */
    resultMetadata?: Record<string, unknown>;
    /**
     * True when this pending entry was synthesized from a Cursor display-only
     * tool_call_* frame (no ExecServerMessage). Continuation must not write an
     * exec result back to Cursor — just clear pending and keep pumping.
     */
    bridged?: boolean;
};
export type ContinuationTerminalReason = "hard-cap-expired" | "remote-clean-close" | "remote-error" | "result-write-failed" | "ambiguous-partial-write" | "heartbeat-write-failed" | "reply-write-failed" | "process-disposed" | "superseded-by-new-run" | "open-session-cap-exceeded";
export type SessionCloseReason = ContinuationTerminalReason | "ordinary-cleanup" | "turn-ended" | "initial-write-failed";
export type ContinuationClaim = {
    session: CursorSession;
    execId: number;
    pending: PendingExec;
};
export type ContinuationClassification = {
    kind: "deliverable";
    session: CursorSession;
    pending: PendingExec;
} | {
    kind: "duplicate";
    reason: "in-flight" | "delivered";
} | {
    kind: "terminal";
    reason: ContinuationTerminalReason;
} | {
    kind: "missing";
    reason: "missing-process-local-state";
};
export type DeliveryOutcome = {
    kind: "delivered";
    framesWritten: number;
} | {
    kind: "duplicate";
    reason: "in-flight" | "delivered";
    framesWritten: 0;
} | {
    kind: "terminal";
    reason: ContinuationTerminalReason;
    framesWritten: number;
} | {
    kind: "missing";
    reason: "missing-process-local-state";
    framesWritten: 0;
};
export type CursorSession = {
    /**
     * Stable per-Run-stream id (distinct from Cursor's own conversation_id).
     * Tags toolCallIds so two concurrent Run streams with overlapping exec ids
     * (Cursor resets them per stream) can't cross-deliver results.
     */
    sessionId: string;
    /** AgentRunRequest.run_id, for context injections bound to this Run. */
    runId?: string;
    /**
     * Cursor conversation_id for this Run — used to store/echo
     * conversation_checkpoint_update (CLI parity).
    */
    conversationId: string;
    /** Cache root owning this conversation's durable restart state. */
    cacheDir?: string;
    /** Latest eligible checkpoint emitted by this Run attempt. */
    resumeCheckpoint?: Uint8Array;
    /** Last checkpoint-derived context snapshot, independent of retry eligibility. */
    tokenDetails?: CursorConversationTokenDetails;
    /** True only after this Run receives a checkpoint containing token details. */
    tokenDetailsFresh?: boolean;
    /**
     * Run-lifetime cache evidence. Cursor exposes only aggregate cache counters at
     * TurnEnded, so retain the inputs and protocol activity needed to explain
     * whether a low ratio came from a cold/rebased prefix, context growth, or a
     * multi-step agent Run.
     */
    cacheDiagnostics?: {
        sessionKey?: string;
        conversationId: string;
        conversationGroupId?: string;
        modelId?: string;
        priorTokenDetails?: CursorConversationTokenDetails;
        startedWithCheckpoint: boolean;
        requestContextReused: boolean;
        requestContextHash: string;
        systemPromptHash?: string;
        checkpointUpdates: number;
        tokenDetailUpdates: number;
        pumpPasses: number;
        stepStarts: number;
        stepCompletes: number;
        displayToolCalls: number;
        execRequests: number;
        createPlanInTurn?: boolean;
        switchModeInTurn?: boolean;
    };
    /** OpenCode session whose own or descendant activity renews tool leases. */
    openCodeSessionId?: string;
    /** Host primary agent whose prompt/permissions this Run was seeded with. */
    hostAgent?: string;
    /** Stable host-system + provider-guidance identity for restart validation. */
    stableSystemPromptHash?: string;
    /** Fresh turn resumed from a stored checkpoint; a blob miss may reseed it. */
    checkpointRebaseEligible?: boolean;
    /** Completed compaction must rebase once before resuming a normal agent. */
    postCompactionRebase?: boolean;
    /**
     * Epoch-held host catalog for this OpenCode session. Refreshed on every
     * `doStream` (including held-Run continuation) so exec #36 and permission
     * can see tools that connected after Run open. Also the lifecycle-turn fallback.
     */
    toolCatalog?: OpencodeToolDef[];
    /** Configured MCP server ids used to split flattened host tool names. */
    knownMcpServers?: string[];
    /** The Run's model accepts images, so held-Run exec results may carry them. */
    supportsImages?: boolean;
    stream: BidiStream;
    frames: AsyncIterator<Frame>;
    /** An iterator read retained across an idle-guard timeout. */
    pendingFrameRead?: Promise<IteratorResult<Frame>>;
    /**
     * One-slot pushback for a terminal update that must start the next pump pass
     * after the host settles emitted tools. Timed-out reads use pendingFrameRead.
     */
    pushbackFrame?: Frame;
    /**
     * In-progress parallel tool-call step (field 27 hold). Cleared when the step
     * finishes; added to priorParallelStepCallIds for late-completion filtering.
     */
    parallelStep?: ParallelStepState;
    /** Resolved call ids from prior steps of this Run — ignore late completions. */
    priorParallelStepCallIds?: Set<string>;
    pending: Map<number, PendingExec>;
    /**
     * Cursor display tool calls (tool_call_started) awaiting either an exec or a
     * tool_call_completed. Keyed by call_id. Cleared when exec handles the call
     * or when we bridge the completed display call into an OpenCode tool-call.
     */
    displayToolCalls: Map<string, Record<string, unknown>>;
    /**
     * Last full todo snapshot successfully mirrored into OpenCode `todowrite`.
     * Used to apply Cursor `merge: true` display updates that omit the final
     * completed list so host todos still receive a replace-all snapshot.
     */
    mirroredTodos?: Array<Record<string, unknown>>;
    /**
     * CreatePlan display calls whose plan was deferred to the host plan agent.
     * Their completed display carries no recorded plan, so it is not mirrored.
     */
    deferredCreatePlanCalls?: Set<string>;
    /**
     * Legacy edit calls whose authoritative exec path is still in progress.
     * Cursor implements these as read -> whole-file write; retaining the path
     * lets the pump expose the final mutation to OpenCode as a targeted edit.
     */
    editToolCalls?: Map<string, {
        path: string;
        completeRead?: boolean;
    }>;
    /** Monotonic synthetic exec ids for bridged (display-only) OpenCode tool calls. */
    nextBridgedExecId: number;
    /** KV blob store: blob_id (hex) → data, for Cursor's out-of-band payload channel. */
    blobs: Map<string, Uint8Array>;
    /** McpToolDefinition list advertised this turn — echoed into the request_context reply. */
    toolDescriptors: Array<Record<string, unknown>>;
    /** Cursor-facing web alias → exact executable host tool for this Run. */
    toolAliases?: ToolAliasRegistry;
    /** OpenCode 1.x `filePath`/`bash` vs 2.x `path`/`shell`, from advertised schemas. */
    hostToolDialect?: HostToolDialect;
    /** Spawnable host agents extracted from this turn's Task/Actor definition. */
    subagentCatalog?: HostSubagentCatalog;
    /** Full RequestContext for exec #10 replies. */
    requestContext: Record<string, unknown>;
    /**
     * False when OpenCode passed no tools (compaction/summary) or toolChoice "none".
     * Cursor may still fire native Grep/etc.; we must refuse those on the Run
     * stream instead of emitting tool-call parts OpenCode will reject.
     */
    allowTools: boolean;
    /**
     * Host-enabled tool names for *this* Run (what actually arrived). May be a
     * subset of the epoch advertisement when plan denies edit — advertise fully
     * for cache stability, but refuse exec outside this set.
     */
    permittedToolNames?: ReadonlySet<string>;
    /**
     * Best-effort held-Run activity counters used only for diagnostics. Displayed
     * AI SDK usage comes from checkpoint occupancy (tool steps) and TurnEnded
     * (stop); this estimate is never sent to OpenCode.
     */
    usageEstimate: {
        inputTokens: number;
        outputTokens: number;
        cacheRead: number;
        cacheWrite: number;
        reasoningTokens: number;
    };
    /**
     * True while a doStream pull() is actively reading this session's frames.
     * Prevents a late cancel/abort from a prior ReadableStream from destroying
     * the Run connection after tool results were delivered (pending cleared) but
     * Cursor is still generating.
    */
    pumpActive: boolean;
    /** The active pull owner; stale cancel callbacks cannot affect a newer pump. */
    pumpOwner: symbol | null;
    heartbeat: ReturnType<typeof setInterval> | null;
    heartbeatCancel: (() => void) | null;
    hardDeadlineTimer: ReturnType<typeof setTimeout> | null;
    semanticDeadlineCancel: (() => void) | null;
    terminalUnsubscribe: (() => void) | null;
    deferredTerminalReason: "remote-clean-close" | "remote-error" | null;
    policy: CursorContinuationPolicy;
    createdAt: number;
    lastInboundAt: number;
    lastHeartbeatWriteAt: number;
    semanticDeadlineAt: number;
    closeError: CursorProviderError | null;
    closed: boolean;
    reopenWithUserMessage?: (text: string) => Promise<void>;
};
type SessionManagerOptions = {
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    activitySource?: SessionActivitySource;
    tombstoneTtlMs?: number;
    tombstoneLimit?: number;
    maxOpenSessions?: number;
};
export declare class SessionManager {
    private byExecId;
    private sessions;
    private byOpenCodeSessionId;
    private tombstones;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly activitySource;
    private readonly tombstoneTtlMs;
    private readonly tombstoneLimit;
    private readonly maxOpenSessions;
    constructor(options?: SessionManagerOptions);
    registerSession(session: CursorSession): void;
    /** Live open Run for this OpenCode session id, if any. */
    findOpenByOpenCodeSessionId(openCodeSessionId: string | undefined): CursorSession | undefined;
    isActivelyPumping(session: CursorSession): boolean;
    /**
     * Clear display-only bridged pendings that do not require a Cursor exec write.
     * Used when the host starts a fresh user turn instead of returning the bridged
     * tool result (e.g. human `continue` while a todowrite mirror is outstanding).
     *
     * @returns number of bridged pendings settled
     */
    settleBridgedPending(session: CursorSession): number;
    private isPumping;
    /**
     * Force-close the oldest idle open session(s) once registration exceeds the
     * cap. Never closes a session with a live pull() mid-await, or one still
     * holding pending execs (continuation / fresh-turn cancel+drain owns those).
     * An unclosable backlog of genuinely active sessions just means the cap
     * can't be enforced until one finishes.
     */
    private enforceOpenSessionCap;
    recordSemanticProgress(session: CursorSession, at?: number): void;
    recordHeartbeatWrite(session: CursorSession): void;
    /** Register that `session` is awaiting a result for `execId`. */
    registerPending(execId: number, session: CursorSession, resultField: string, toolName?: string, bridged?: boolean, resultMetadata?: Record<string, unknown>): void;
    /** The pending exec info for an id on a specific session, if still awaiting it. */
    pendingFor(sessionId: string, execId: number): PendingExec | undefined;
    classify(sessionId: string, execId: number): ContinuationClassification;
    claim(sessionId: string, execId: number): ContinuationClaim | ContinuationClassification;
    deliverClaim(claim: ContinuationClaim, frames: readonly Uint8Array[]): DeliveryOutcome;
    /** Find the live session awaiting one of the given exec ids. */
    findByExecIds(sessionId: string, execIds: number[]): CursorSession | undefined;
    /** Mark an exec id as resolved (its result has been delivered). */
    resolve(sessionId: string, execId: number): void;
    beginPump(session: CursorSession, owner: symbol): void;
    isPumpOwner(session: CursorSession, owner: symbol): boolean;
    endPump(session: CursorSession, owner: symbol): boolean;
    /**
     * Swap the live bidi Run while a pump is still pulling frames.
     * Callers must cancel the session heartbeat and wait for the old stream's
     * write chain before this, so an in-flight heartbeat cannot close the session.
     */
    replaceStream(session: CursorSession, next: BidiStream, runId?: string): void;
    private subscribeTerminal;
    private key;
    close(session: CursorSession, reason?: SessionCloseReason, error?: CursorProviderError): void;
    /**
     * Close only if nothing is awaiting a tool result AND no pull() is actively
     * pumping this session. OpenCode aborts each doStream after finishReason
     * "tool-calls"; that abort must NOT tear down the Cursor Run stream.
     * Equally, a late cancel from the previous ReadableStream must not destroy
     * the session once the continuation has cleared pending and resumed pumping.
     * Returns true if the session was closed.
     */
    closeUnlessPending(session: CursorSession): boolean;
    dispose(): void;
    sweepHardDeadlines(): void;
    private onStreamTerminal;
    private refreshHardDeadline;
    private hardDeadlineExpired;
    private scheduleHardDeadline;
    private getTombstone;
    private putTombstone;
    private isTerminalReason;
}
/**
 * Read one frame, retaining ownership of the iterator read when a timeout
 * wins. Every reader uses this function so a continuation cannot overtake a
 * late frame (or discard its EOF/error).
 */
export declare function readSessionFrame(session: CursorSession): Promise<IteratorResult<Frame>>;
export declare function readSessionFrame(session: CursorSession, timeoutMs: number): Promise<IteratorResult<Frame> | {
    done: true;
    timedOut: true;
}>;
export declare const sessionManager: SessionManager;
export {};
