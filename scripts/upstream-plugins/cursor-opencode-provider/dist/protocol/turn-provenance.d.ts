import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
/** Mirrors MAX_TURN_STATE_SESSIONS; evicted sessions re-hydrate from disk. */
export declare const MAX_PROVENANCE_SESSIONS = 256;
export type TurnProvenance = {
    conversationId: string;
    /** Tool call ids emitted in the latest non-empty step. */
    toolCallIds: string[];
    /** Whitespace-free text emitted in the latest non-empty step (first 4 KiB). */
    text: string;
    /**
     * Whitespace-free reasoning and text of the same step in emission order
     * (first 4 KiB). OpenCode 1.x replays a previous model's reasoning as text
     * parts after a model switch (`session/message-v2.ts` `differentModel`), and
     * OpenCode 2 does the same for an assistant message that ended in error.
     */
    textWithReasoning: string;
};
export type ForeignHistoryReason = "foreign-assistant";
/**
 * Mark the start of one host step (one doStream). The previous step stays
 * recorded until this one emits content, because hosts drop empty assistant
 * turns from history.
 */
export declare function beginEmittedStep(sessionKey: string, conversationId: string): void;
/** Record one stream part this provider handed to the host. */
export declare function recordEmittedPart(sessionKey: string, conversationId: string, part: {
    type: string;
    delta?: unknown;
    toolCallId?: unknown;
}): void;
/**
 * Bind provenance to the conversation a Run was opened on. A reminted
 * conversation starts with an empty record, so it never inherits the previous
 * conversation's steps.
 */
export declare function trackTurnProvenance(sessionKey: string, conversationId: string): void;
export declare function getTurnProvenance(sessionKey: string): TurnProvenance | undefined;
export declare function restoreTurnProvenance(sessionKey: string, value: TurnProvenance): void;
export declare function resetTurnProvenanceForTests(): void;
export declare function serializeTurnProvenance(value: TurnProvenance): string;
export declare function parseTurnProvenance(raw: string): TurnProvenance | undefined;
/**
 * Decide whether the host history moved past this Cursor conversation.
 * Returns undefined when there is no evidence either way (no record for this
 * conversation, or no assistant turn yet), so unknown state never forces a
 * rebase.
 */
export declare function detectForeignHistory(input: {
    sessionKey: string | undefined;
    conversationId: string;
    prompt: LanguageModelV3CallOptions["prompt"];
}): ForeignHistoryReason | undefined;
