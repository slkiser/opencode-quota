import type { FileHandle } from "node:fs/promises";
export declare const MAX_CACHE_HEADER_BYTES: number;
export declare const MAX_CACHE_HEADER_INPUT_BYTES: number;
export type ConversationCacheHeader = {
    schemaVersion: number;
    sessionKey: string;
    conversationId: string;
    updatedAt: number;
};
export type CacheHeaderResult = {
    status: "metadata";
    value: ConversationCacheHeader;
} | {
    status: "invalid" | "indeterminate";
};
/** A prefix is a retention hint, never evidence of payload/checksum validity. */
export declare function parseConversationCacheHeader(bytes: Uint8Array): CacheHeaderResult | undefined;
/**
 * Inspect an opened generation without reading its checkpoint/blobs/context.
 * Positional reads leave the handle's offset at zero for subsequent full loading.
 * Stop BOTH streams on success; merely breaking consumption leaves inflation live.
 */
export declare function readConversationCacheHeader(handle: FileHandle, signal?: AbortSignal): Promise<CacheHeaderResult>;
