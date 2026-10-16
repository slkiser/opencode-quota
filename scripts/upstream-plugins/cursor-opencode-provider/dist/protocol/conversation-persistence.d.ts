import type { ConversationBlobSnapshot } from "./blob-store.js";
import type { OpencodeToolDef } from "./tools.js";
export type PersistedConversation = {
    sessionKey: string;
    conversationId: string;
    updatedAt: number;
    checkpoint?: Uint8Array;
    blobs: ConversationBlobSnapshot[];
    requestContext: Record<string, unknown>;
    toolCatalog: OpencodeToolDef[];
    postCompactionRebase: boolean;
    hostAgent?: string;
    systemPromptHash?: string;
    /** JSON-encoded TurnProvenance (what this provider emitted last). */
    turnProvenance?: string;
};
export type ConversationLoadStatus = "restored" | "missing" | "invalid" | "expired";
export type PersistedConversationLoad = {
    status: ConversationLoadStatus;
    value?: PersistedConversation;
};
export declare function conversationCacheDirectoryPath(cacheDir: string): string;
export declare function conversationCacheFilePath(cacheDir: string, sessionKey: string): string;
/** Create the per-session cache directory and prune records older than 24 hours once per process. */
export declare function initializeConversationPersistence(cacheDir: string, now?: number): Promise<void>;
export declare function getPersistedConversation(cacheDir: string, sessionKey: string, now?: number): Promise<PersistedConversation | undefined>;
/** Read a snapshot together with the reason restart hydration did not restore it. */
export declare function loadPersistedConversation(cacheDir: string, sessionKey: string, now?: number): Promise<PersistedConversationLoad>;
/** Replace one session's durable snapshot and refresh its 24-hour lease. */
export declare function persistConversation(cacheDir: string, value: Omit<PersistedConversation, "updatedAt" | "postCompactionRebase" | "toolCatalog"> & {
    postCompactionRebase?: boolean;
    toolCatalog?: OpencodeToolDef[];
}, now?: number): Promise<void>;
/** Delete only the expected binding so an overlapping newer turn cannot be removed. */
export declare function deletePersistedConversation(cacheDir: string, sessionKey: string, expectedConversationId?: string): Promise<void>;
export declare function resetConversationPersistenceForTests(): void;
