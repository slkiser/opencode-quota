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
    /** Why a Run started without a checkpoint: a reset reason, `ephemeral`, or `no-checkpoint`. */
    coldReason?: string;
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
/**
 * One-line proof that Cursor, AI SDK, and projected OpenCode totals agree.
 * `counterKind` names what `counters` hold so the line labels them truthfully:
 * Cursor's TurnEnded request counters (`raw*`) or the occupancy-shaped counters
 * of {@link occupancyValidationCounters} (`occupancy*`).
 */
export declare function formatTurnUsageValidation(counters: CursorUsageCounters, usage: LanguageModelV3Usage, tokenDetails?: CursorConversationTokenDetails, contextSource?: CursorContextUsageSource, counterKind?: "turn-ended" | "occupancy"): string;
/**
 * The `finish:` trace. `v3*` is the usage sent to OpenCode. The second group is
 * labelled by where its numbers come from: `raw*` are Cursor's TurnEnded
 * request counters (whole Run), `occupancy*` the checkpoint snapshot a
 * tool-call boundary sends (its cache split as billed: the previous step's
 * context, see `src/billing.ts`), and
 * `est*` the provider's char/4 estimate before any checkpoint arrived.
 */
export declare function formatFinishTrace(input: {
    reason: string;
    usage: LanguageModelV3Usage;
    turnEnded?: CursorUsageCounters;
    occupancy?: {
        usedTokens: number;
        priorUsedTokens: number;
    };
    estimate: CursorUsageCounters;
    source: string;
}): string;
/**
 * A warning when Cursor's checkpoint counts no rules although this Run sent the
 * system-instructions rule: the host system context (AGENTS.md, skills,
 * subagents) is then likely absent from the model's prompt. Undefined when the
 * breakdown is missing or stale, or when rules were counted.
 */
export declare function missingRulesWarning(details: CursorConversationTokenDetails | undefined, sentRuleChars: number, conversationId: string): string | undefined;
/** OpenCode requires a usage object at every step boundary. */
export declare function emptyLanguageModelV3Usage(): LanguageModelV3Usage;
/**
 * Occupancy-shaped counters for {@link formatTurnUsageValidation}: `usedTokens`
 * with `prior.usedTokens` of it cached, the shape every step finish sends
 * (`shapeStepUsage` in `src/billing.ts`). Always validate occupancy finishes —
 * including TurnEnded/stop — against these, not against aggregate TurnEnded
 * request counters. Request cache ratios stay on `finish:` / cache diagnosis.
 */
export declare function occupancyValidationCounters(details: CursorConversationTokenDetails, prior?: CursorConversationTokenDetails): CursorUsageCounters;
/** Project nested V3 usage into the common flat AI-SDK counter shape. */
export declare function flatUsageFromV3(usage: LanguageModelV3Usage): {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
};
