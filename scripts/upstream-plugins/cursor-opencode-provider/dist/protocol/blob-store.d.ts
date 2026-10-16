/**
 * Cursor CLI keeps conversation blobs in a durable client store (SQLite) across
 * Runs. ConversationStateStructure only holds blob IDs; the server re-fetches
 * them via get_blob on the next turn. Our per-Run session.blobs Map was wiped
 * on stream close, so follow-up gets echoed 32-byte hashes → server JSON.parse
 * fails ("Unexpected token ... is not valid JSON").
 *
 * This store is keyed by conversation_id and survives across Run streams.
 * At a successful TurnEnded it is compacted to the graph reachable from the
 * latest checkpoint, matching Cursor CLI's conversation-export traversal.
 */
export declare function setConversationBlob(conversationId: string, blobId: Uint8Array, blobData: Uint8Array): string;
export declare function getConversationBlob(conversationId: string, blobId: Uint8Array): Uint8Array | undefined;
export declare function conversationBlobCount(conversationId: string): number;
export type ConversationBlobSnapshot = {
    id: string;
    data: Uint8Array;
};
export type ConversationBlobCompaction = {
    blobs: ConversationBlobSnapshot[];
    beforeCount: number;
    beforeBytes: number;
    afterCount: number;
    afterBytes: number;
    compacted: boolean;
    fallbackReason?: string;
};
export type ConversationBlobGraphStats = {
    count: number;
    bytes: number;
    complete: boolean;
    fallbackReason?: string;
};
/**
 * Measure the checkpoint-reachable blob graph without mutating the store.
 * Incomplete graphs conservatively report the complete retained bucket, since
 * that is what the KV channel may have to serve if the checkpoint is used.
 */
export declare function inspectConversationBlobGraph(conversationId: string, checkpoint: Uint8Array | undefined): ConversationBlobGraphStats;
/** Copy all durable blobs so a completed turn can be persisted atomically. */
export declare function snapshotConversationBlobs(conversationId: string): ConversationBlobSnapshot[];
/**
 * Keep only blobs reachable from the latest checkpoint and snapshot them.
 * Malformed/unknown state or a missing referenced hash falls back to retaining
 * every blob: cache size must never come at the cost of restart correctness.
 */
export declare function compactConversationBlobs(conversationId: string, checkpoint: Uint8Array | undefined): ConversationBlobCompaction;
/** Replace the in-memory blob bucket when restoring a persisted conversation. */
export declare function restoreConversationBlobs(conversationId: string, blobs: readonly ConversationBlobSnapshot[]): void;
/** Drop all blobs for a conversation (compaction conversation reset). */
export declare function clearConversationBlobs(conversationId: string): void;
/** SHA-256 content hashes are 32 non-text bytes — never echo those as content. */
export declare function isBlobIdHash(blobId: Uint8Array): boolean;
export declare function resetConversationBlobsForTests(): void;
