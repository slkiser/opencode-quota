export type LostRequest = {
    conversationId: string;
    checkpointKey: string;
    /** Everything Cursor has not checkpointed, as the last attempt sent it. */
    text: string;
    /** That attempt's own live text, before anything was prepended. */
    latest: string;
};
export declare function checkpointKey(bytes: Uint8Array | undefined): string;
/**
 * Prepend a user message whose Run never received a newer checkpoint.
 * A history rebuild already contains it, so that path drops the record.
 * A retry is the previous attempt's live text again: it sends what that
 * attempt sent. A host that sends the same note before every attempt must not
 * pile it up. Any other text is a new request and is appended, even when it
 * repeats an older one (red, blue, then red again).
 */
export declare function carryLostRequest(input: {
    sessionKey: string;
    conversationId: string;
    checkpoint: Uint8Array | undefined;
    text: string;
    rebuildFromHistory: boolean;
}): string;
/** `text` is what this turn sends; `latest` is its own live text (defaults to `text`). */
export declare function rememberLostRequest(input: {
    sessionKey: string;
    conversationId: string;
    checkpoint: Uint8Array | undefined;
    text: string;
    latest?: string;
}): void;
/** A checkpoint other than the one this turn was sent on means Cursor kept the turn. */
export declare function noteCheckpoint(sessionKey: string | undefined, bytes: Uint8Array): void;
export declare function hasLostRequest(sessionKey: string | undefined): boolean;
export declare function dropLostRequest(sessionKey: string | undefined): void;
export declare function serializeLostRequest(sessionKey: string | undefined): string | undefined;
export declare function restoreLostRequest(sessionKey: string, raw: string | undefined): void;
export declare function resetLostRequestsForTests(): void;
