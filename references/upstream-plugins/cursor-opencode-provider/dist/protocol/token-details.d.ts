export type CursorPromptTokenCategory = {
    id: string;
    label: string;
    estimatedTokens: number;
    characterCount?: number;
};
export type CursorPromptTokenBreakdown = {
    totalUsedTokens: number;
    maxTokens: number;
    categories: CursorPromptTokenCategory[];
};
export type CursorConversationTokenDetails = {
    usedTokens: number;
    maxTokens: number;
    breakdown?: CursorPromptTokenBreakdown;
};
export type CursorContextUsageSource = "checkpoint-current-run" | "checkpoint-previous-turn";
/** Cursor can update occupancy while retaining categories from an older checkpoint. */
export declare function currentCursorTokenBreakdown(details: CursorConversationTokenDetails | undefined): CursorPromptTokenBreakdown | undefined;
/**
 * Read field #5 (`ConversationTokenDetails`) from Cursor's opaque
 * `ConversationStateStructure` checkpoint without decoding or re-encoding the
 * rest of the state. Unknown checkpoint fields therefore remain byte-exact.
 */
export declare function decodeConversationTokenDetails(checkpoint: Uint8Array | undefined): CursorConversationTokenDetails | undefined;
export declare function cursorContextUsageMetadata(details: CursorConversationTokenDetails, source?: CursorContextUsageSource): {
    contextUsageVersion: number;
    source: CursorContextUsageSource;
    stale: boolean;
    usedTokens: number;
    maxTokens: number;
    remainingTokens: number;
    usedPercent?: number;
    breakdown?: CursorPromptTokenBreakdown;
};
