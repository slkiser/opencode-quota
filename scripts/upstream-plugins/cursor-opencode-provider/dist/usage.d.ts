import type { LanguageModelV3Usage } from "@ai-sdk/provider";
import type { CursorContextUsageSource, CursorConversationTokenDetails } from "./protocol/token-details.js";
export type CursorUsageCounters = {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    reasoningTokens: number;
};
export type CursorUsageOptions = {
    /** Cursor checkpoint occupancy, including the current turn's output. */
    contextTotalTokens?: number;
    /** Previous turn's occupancy. When Cursor's cache read covers this window, do not dilute the hit by multi-step TurnEnded aggregates. */
    priorContextTokens?: number;
};
export type CursorCacheDiagnosticStats = {
    sessionKey?: string;
    conversationId: string;
    conversationGroupId?: string;
    modelId?: string;
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
    /** A CreatePlan interaction ran this Run (any outcome). Tags one-time upstream tools expansion. */
    createPlanInTurn?: boolean;
    /** A SwitchMode interaction ran this Run (any outcome). */
    switchModeInTurn?: boolean;
};
/** Non-negative integer counter from a Cursor `turn_ended` field. */
export declare function turnEndedCounter(te: Record<string, unknown>, key: string): number;
export declare function cursorUsageCountersFromTurnEnded(te: Record<string, unknown>): CursorUsageCounters;
/**
 * Map Cursor counters to AI SDK V3. Cursor's `input_tokens` already includes
 * cache reads/writes, and `output_tokens` already includes reasoning.
 */
export declare function buildLanguageModelV3UsageFromCounters(counters: CursorUsageCounters, options?: CursorUsageOptions): LanguageModelV3Usage;
export declare function buildLanguageModelV3UsageFromTurnEnded(te: Record<string, unknown>, options?: CursorUsageOptions): LanguageModelV3Usage;
/** Compact, parseable category snapshot for checkpoint-by-checkpoint traces. */
export declare function formatCursorTokenCategories(details: CursorConversationTokenDetails | undefined): string;
/**
 * Explain Cursor's aggregate cache counters using the state visible to this
 * client. `stepStarts` is deliberately not called a model-call count: Cursor
 * does not expose per-model-call cache accounting on the Run stream.
 */
export declare function formatCursorCacheDiagnostics(counters: CursorUsageCounters, current: CursorConversationTokenDetails | undefined, prior: CursorConversationTokenDetails | undefined, stats: CursorCacheDiagnosticStats): string;
/** One-line proof that Cursor, AI SDK, and projected OpenCode totals agree. */
export declare function formatTurnUsageValidation(counters: CursorUsageCounters, usage: LanguageModelV3Usage, tokenDetails?: CursorConversationTokenDetails, contextSource?: CursorContextUsageSource): string;
/** OpenCode requires a usage object at every step boundary. */
export declare function emptyLanguageModelV3Usage(): LanguageModelV3Usage;
/**
 * OpenCode TUI/GUI replace each assistant message's `tokens` (they do not sum
 * occupancy). The TUI footer picks the last assistant with `tokens.output > 0`.
 * Session cost, however, adds every step-finish. Checkpoint occupancy is
 * therefore sent as a snapshot with `output=1` so the footer accepts it, and
 * callers attach {@link OPENCODE_DISPLAY_ONLY_COST_METADATA} so getUsage
 * reports $0 instead of billing the snapshot as a new prompt.
 */
export declare const OPENCODE_DISPLAY_ONLY_COST_METADATA: {
    readonly copilot: {
        readonly totalNanoAiu: 0;
    };
};
/**
 * Counters that mirror {@link occupancyUsageFromTokenDetails} for
 * {@link formatTurnUsageValidation}. Always validate occupancy finishes —
 * including TurnEnded/stop — against these, not against aggregate TurnEnded
 * request counters. Request cache ratios stay on `finish:` / cache diagnosis.
 */
export declare function occupancyValidationCounters(details: CursorConversationTokenDetails, prior?: CursorConversationTokenDetails): CursorUsageCounters;
export declare function occupancyUsageFromTokenDetails(details: CursorConversationTokenDetails, prior?: CursorConversationTokenDetails): LanguageModelV3Usage;
/** Project nested V3 usage into the common flat AI-SDK counter shape. */
export declare function flatUsageFromV3(usage: LanguageModelV3Usage): {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
};
