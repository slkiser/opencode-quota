import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { CreateCursorOptions, CursorRetryOptions } from "./index.js";
import { type OpencodeToolDef } from "./protocol/tools.js";
import { cursorContextUsageMetadata, type CursorContextUsageSource, type CursorConversationTokenDetails } from "./protocol/token-details.js";
import { type ConversationBlobGraphStats } from "./protocol/blob-store.js";
import { type CursorSession } from "./session.js";
import { CursorProviderError } from "./errors.js";
import { type ModelInfo } from "./models.js";
import type { SeedHistoryMessage } from "./protocol/request.js";
import { type CursorImageInput } from "./image-input.js";
type PromptIdentity = {
    hostAgent?: string;
    systemPromptHash?: string;
};
export declare const MAX_TURN_STATE_SESSIONS = 256;
/**
 * Cursor CLI's conversation **export / transfer-to-cloud** path treats state
 * above 100 MiB as large (`conversation-export.ts` default `104857600`). That
 * budget must not remint a sticky conversation on resume — CLI soft-reuses.
 */
export declare const MAX_CHECKPOINT_BLOB_GRAPH_BYTES: number;
/** @deprecated Never remints; kept for call-site/tests. Always false. */
export declare function checkpointBlobGraphRequiresRebase(_stats: ConversationBlobGraphStats, _maxBytes?: number): boolean;
/** Warn-only concern for incomplete / oversized checkpoint graphs (no remint). */
export declare function checkpointBlobGraphConcern(stats: ConversationBlobGraphStats, maxBytes?: number): "incomplete-checkpoint-graph" | "oversized-checkpoint-graph" | undefined;
/**
 * True when the raw frame holds exactly one control message: a KV request, a
 * checkpoint update, or an interaction update that is only a heartbeat. Extra
 * fields inside a KV request are tolerated (Cursor has sent them live); extra
 * top-level fields are not.
 */
export declare function isSoleControlFrame(payload: Uint8Array): boolean;
export type CursorRetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
};
export declare function resolveRetryPolicy(options: CursorRetryOptions | undefined): CursorRetryPolicy;
export declare function connectFrameError(payload: string): CursorProviderError;
/** Restore the epoch catalog for the next nonempty host turn. */
export declare function restoreTurnToolCatalog(sessionKey: string, tools: OpencodeToolDef[]): void;
/** Record the authoritative host todo list for an OpenCode session. */
export declare function rememberMirroredTodos(sessionKey: string | undefined, todos: ReadonlyArray<Record<string, unknown>>): void;
/** Copy of the last known host todo list for an OpenCode session, if any. */
export declare function snapshotMirroredTodosBySession(sessionKey: string | undefined): Array<Record<string, unknown>> | undefined;
/**
 * Prompt identity is diagnostics / persistence only and never drives remint.
 * Kept as a named helper so call sites / tests that still mention identity
 * churn have a single no-op definition.
 */
export declare function promptIdentityWouldRemint(_previous: PromptIdentity, _current: PromptIdentity): boolean;
/** Test helper: content hashes recorded after a successful held-Run image write. */
export declare function snapshotSentHistoryImageHashesForTests(sessionKey: string): string[];
type V3Part = LanguageModelV3StreamPart;
export declare function createCursorLanguageModel(modelId: string, providerId: string, options: CreateCursorOptions): LanguageModelV3;
export declare function pumpWithRecovery(input: {
    initialSession: CursorSession;
    controller: ReadableStreamDefaultController<V3Part>;
    abortSignal?: AbortSignal;
    retryPolicy?: CursorRetryPolicy;
    recover: (recovery: CursorRunRecovery) => Promise<CursorSession>;
    onSession?: (session: CursorSession) => void;
    maxRecoveries?: number;
    /**
     * Set when the credential source can renew: called once per turn after
     * Cursor rejects the token (401 / unauthenticated) before the attempt did
     * anything, so the reopened Run uses a force-renewed token. This retry does
     * not count against the transient-failure budget.
     */
    renewRejectedCredential?: () => void;
}): Promise<CursorSession>;
export type CursorRunRecovery = {
    kind: "rebase";
    reason?: "checkpoint-unusable";
} | {
    kind: "resume";
    conversationId: string;
    checkpoint: Uint8Array;
};
/** Start (or replace) the per-session heartbeat. In-flight writes from a prior attach are ignored. */
export declare function attachSessionHeartbeat(session: CursorSession): void;
/**
 * OpenCode re-sends the full tool-result history on every continuation. Prefer
 * the newest result that still has a live pending exec on its tagged session.
 */
export declare function findContinuationSession(toolResults: Array<{
    sessionId: string;
    execId: number;
}>): CursorSession | undefined;
/**
 * True when `incoming` is a non-empty proper subset of `parent` by tool name.
 * Used to spot in-session helpers that reuse the parent OpenCode session id
 * with a reduced catalog (e.g. stripping `task` / `question` / `plan_exit`).
 */
export declare function isProperCatalogSubset(incoming: ReadonlyArray<{
    name?: string;
}>, parent: ReadonlyArray<{
    name?: string;
}>): boolean;
/**
 * An open parent Run for this OpenCode session whose catalog strictly contains
 * the incoming tools is treated as an in-session helper unless the request
 * carries a result for that parent's pending call. A result can precede a new
 * user message or agent-change reminder and still needs to reach the parent.
 * Helper calls must not cancel/supersede the parent.
 */
export declare function shouldIsolateInSessionHelper(openCodeSessionId: string | undefined, incomingTools: ReadonlyArray<{
    name?: string;
}>, historicalResults?: ExtractedToolResult[]): boolean;
/** How long a fresh-turn drain may wait for Cursor `turn_ended` after bridged settle. */
export declare const FRESH_TURN_DRAIN_TIMEOUT_MS = 8000;
/**
 * Error text written onto Cursor execs that the host abandoned by starting a
 * new user turn before returning the tool result. Completing the held Run with
 * this cancel (then draining to `turn_ended`) keeps the same conversation
 * prefix instead of `superseded-by-new-run` mid-exec.
 */
export declare const FRESH_TURN_PENDING_CANCEL_REASON = "Host started a new user turn before this tool result was delivered";
/**
 * Before opening a new user-turn Run, finish the prior held-open Run cleanly:
 * settle display-only bridged pendings, cancel any real execs still waiting on
 * the host, then drain for `turn_ended`. That preserves the same
 * conversation_id / checkpoint prefix instead of aborting mid-tool.
 */
export declare function preparePriorSessionForFreshTurn(openCodeSessionId: string | undefined, opts?: {
    timeoutMs?: number;
    /** Tool results already in this prompt; deliver any that match held pendings before cancel. */
    toolResults?: ExtractedToolResult[];
    hostAgent?: string;
}): Promise<"drained" | "settled-only" | "busy" | "none">;
/**
 * Write error/reject results for every still-open non-bridged pending on the
 * held Run so Cursor can finish the agent turn instead of being superseded.
 *
 * @returns number of pendings successfully cancelled
 */
export declare function cancelPendingExecsForFreshTurn(session: CursorSession): number;
/**
 * Read remaining frames on an idle held-open Run until `turn_ended`, a
 * response-requiring request we cannot answer without the host, or timeout.
 * Used only on the fresh-turn settle path — not a general pump substitute.
 */
export declare function drainSessionUntilTurnEnded(session: CursorSession, opts?: {
    timeoutMs?: number;
}): Promise<"turn-ended" | "busy" | "timeout" | "interrupted" | "skipped">;
export declare function deliverContinuationResults(session: CursorSession, trailingToolResults: ExtractedToolResult[], 
/** Host primary agent of the request that carries these results. */
delivery?: {
    hostAgent?: string;
}): CursorSession | undefined;
/**
 * Read the held-open stream, emitting stream parts, until the turn boundary:
 *  - tool call(s) for one Cursor generation → emit each tool-call as it
 *    arrives; finish "tool-calls" once Cursor's listed count (field 27) is
 *    met (or immediately when the process has never seen field 27); KEEP the
 *    session open for results on the next doStream call;
 *  - turn_ended → finish "stop" and close the session;
 *  - transport EOF before turn_ended → throw for one fresh-Run recovery
 *    (after host tools were already emitted, finish "tool-calls" instead and
 *    let the continuation rebase).
 */
export declare function pump(session: CursorSession, controller: ReadableStreamDefaultController<V3Part>, ids: {
    textId: string;
    reasoningId: string;
}, abortSignal?: AbortSignal): Promise<void>;
type ToolResultContent = {
    toolCallId: string;
    toolName: string;
    output: string;
    error?: string;
    /** Host media parts of this result (own content, or the trailing media message). */
    media?: unknown[];
    /** `media` decoded for the exec result, with content hashes in the same order. */
    images?: CursorImageInput[];
    imageHashes?: string[];
    /** Host updates that a binary read cannot carry in its output oneof. */
    notes?: string;
};
type ExtractedToolResult = ToolResultContent & {
    sessionId: string;
    execId: number;
};
export declare function extractTrailingToolResults(prompt: LanguageModelV3CallOptions["prompt"]): ExtractedToolResult[];
/** Decode only image-bearing pending execs, under one continuation-wide budget. */
export declare function decodeTrailingToolImages(session: CursorSession, results: ExtractedToolResult[], signal?: AbortSignal, maxBytes?: number): Promise<ExtractedToolResult[]>;
/** Detect a host-owned canonical plan review, excluding Cursor exec replies. */
export declare function hasApprovedUncorrelatedPlanStageResult(prompt: LanguageModelV3CallOptions["prompt"]): boolean;
/**
 * Keep the workspace root on a checkpointed turn's live user message too, and
 * require absolute `path` arguments when that is the host's file-tool dialect.
 */
export declare function groundCheckpointTurnText(userText: string, checkpoint: boolean, workspaceRoot: string, tools: readonly {
    name?: string;
    inputSchema?: unknown;
}[]): string;
/**
 * Cursor's native UI interactions cannot be surfaced through the AI SDK.
 * Redirect only to OpenCode tools that are genuinely advertised this turn;
 * compaction keeps its dedicated summary prompt unchanged.
 */
export declare function buildOpenCodeInteractionGuidance(tools: OpencodeToolDef[], isCompaction: boolean, workspaceRoot: string, options?: {
    knownMcpServers?: Iterable<string>;
    allowTools?: boolean;
}): string | undefined;
/** Rough char→token estimate for mid-turn usage before TurnEnded arrives. */
export declare function estimateTokens(chars: number): number;
/** Preserve exact request-local Cursor counters as diagnostics. */
export declare function cursorTurnEndedProviderMetadata(te: Record<string, unknown>, tokenDetails?: CursorConversationTokenDetails, contextSource?: CursorContextUsageSource): {
    cursor: {
        usageVersion: number;
        inputTokensRaw: number;
        outputTokensRaw: number;
        cacheReadRaw: number;
        cacheWriteRaw: number;
        reasoningTokensRaw: number;
        context?: ReturnType<typeof cursorContextUsageMetadata>;
    };
};
/**
 * Prior prompt turns for a seed ConversationStateStructure. Tool results must
 * never be replayed as assistant-authored prose: that teaches the model to
 * counterfeit `Tool result (...)` text instead of emitting a real tool call.
 * Normal rebases omit old results; compaction can retain all results and
 * interrupted continuations retain only the trailing live result suffix as
 * explicit OpenCode-host observations.
 */
export declare function extractPromptHistory(prompt: LanguageModelV3CallOptions["prompt"], options?: {
    preserveTrailingUser?: boolean;
    toolResults?: "omit" | "all" | "trailing";
}): SeedHistoryMessage[];
/** Share of the target context a foreign-history rebase may fill before compaction. */
export declare const FOREIGN_HISTORY_REBASE_CONTEXT_SHARE = 0.8;
/**
 * A foreign-history rebase replays the full host history. When that cannot fit,
 * fail before opening a Run with an error hosts classify as context overflow
 * (HTTP 413 + "prompt is too long"), so the host compacts and retries.
 */
export declare function assertForeignHistoryRebaseFits(input: {
    modelInfo: ModelInfo | undefined;
    cursorModelId: string;
    maxMode: boolean;
    history: SeedHistoryMessage[];
    systemPrompt: string | undefined;
    userText: string;
}): void;
/** OpenCode session id header, if present. */
export declare function opencodeSessionKey(callOptions: LanguageModelV3CallOptions): string | undefined;
/**
 * Map OpenCode's session id header to the active Cursor conversation_id.
 * Compaction resets remint via bindConversationId; otherwise the binding is
 * sticky for the OpenCode session. Falls back to a random UUID with no header.
 */
export declare function resolveConversationId(callOptions: LanguageModelV3CallOptions): string;
export { sessionIdToUuid } from "./protocol/conversation-bind.js";
/**
 * Grow the held Run's advertised + permitted catalog from this `doStream`
 * call. Continuation skips `startSession`, so without this, exec #36 and
 * permission keep the freeze from Run open. MCP server ids stay those of the
 * Run's one merged-config load (`startSession`); a tool that connects later
 * still gets its identity from that set.
 */
export declare function refreshHeldSessionToolCatalog(session: CursorSession, callOptions: LanguageModelV3CallOptions): Promise<void>;
/** Exported for tests — AI SDK V3 span ends that must precede finish / tool-call. */
export declare function spanEndParts(opts: {
    textStarted: boolean;
    reasoningStarted: boolean;
    textId: string;
    reasoningId: string;
}): Array<{
    type: "text-end" | "reasoning-end";
    id: string;
}>;
/** Exported for tests — false for compaction/summary (no tools) and toolChoice none. */
export declare function computeAllowTools(toolCount: number, toolChoice: LanguageModelV3CallOptions["toolChoice"] | undefined): boolean;
/**
 * OpenCode title/summary take the first non-empty line of the answer. After a
 * lifecycle refuse, Cursor often narrates that tools are unavailable — drop
 * that so it does not become the session title.
 */
export declare function shouldDropLifecycleToollessText(text: string, refusedExec: boolean): boolean;
export declare function resolveTurnToolState(input: {
    sessionKey?: string;
    incomingTools: OpencodeToolDef[];
    toolChoice?: LanguageModelV3CallOptions["toolChoice"];
    isCompaction: boolean;
    abortSignal?: AbortSignal;
}): Promise<{
    advertisedTools: OpencodeToolDef[];
    allowTools: boolean;
}>;
export declare function resolveTurnConversationReset(input: {
    sessionKey?: string;
    isCompaction: boolean;
    historyRewrite?: boolean;
    /** @deprecated Ignored — prompt identity never remints. Kept for call-site compat. */
    promptIdentity?: PromptIdentity;
}): {
    reset: boolean;
    reason?: "compaction" | "post-compaction-rebase" | "history-rewrite";
};
export declare function resetTurnStateForTests(): void;
