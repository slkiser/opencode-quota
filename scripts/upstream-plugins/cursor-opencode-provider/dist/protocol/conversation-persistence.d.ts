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
    /**
     * Host note bodies the last turn ended without delivering (ordered; encoded
     * via encodePersistedHostNotes). The Cursor checkpoint does not hold them.
     */
    hostNote?: string;
    /** Bounded early-steer delivery receipts for the saved checkpoint. */
    earlySteers?: string;
    /** JSON lost-request record: user text sent on a checkpoint Cursor never advanced. */
    lostRequest?: string;
    /** Content hashes of the history images `sentImagesCheckpoint` holds. */
    sentImageHashes?: string[];
    /** SHA-256 hex of the checkpoint `sentImageHashes` belongs to; without it no image counts as held. */
    sentImagesCheckpoint?: string;
};
export type ConversationLoadStatus = "restored" | "missing" | "invalid" | "expired";
export type PersistedConversationLoad = {
    status: ConversationLoadStatus;
    value?: PersistedConversation;
};
type PersistenceTestPhase = "maintenance-start" | "before-quarantine" | "after-quarantine" | "full-decode" | "directory-opened" | "before-write";
declare let testHook: ((phase: PersistenceTestPhase, filePath: string) => Promise<void> | void) | undefined;
export declare function conversationCacheDirectoryPath(cacheDir: string): string;
export declare function conversationCacheFilePath(cacheDir: string, sessionKey: string): string;
/** Readiness includes directory permissions only; maintenance never gates hydration. */
export declare function initializeConversationPersistence(cacheDir: string, now?: number): Promise<void>;
export declare function getPersistedConversation(cacheDir: string, sessionKey: string, now?: number): Promise<PersistedConversation | undefined>;
/** Read a snapshot together with the reason restart hydration did not restore it. */
export declare function loadPersistedConversation(cacheDir: string, sessionKey: string, now?: number): Promise<PersistedConversationLoad>;
/** Turn provenance of the current snapshot, without decoding its payload. */
export declare function getPersistedTurnProvenance(cacheDir: string, sessionKey: string, now?: number): Promise<{
    conversationId: string;
    turnProvenance: string;
} | undefined>;
/** Replace one session's durable snapshot and refresh its 24-hour lease. */
export declare function persistConversation(cacheDir: string, value: Omit<PersistedConversation, "updatedAt" | "postCompactionRebase" | "toolCatalog"> & {
    postCompactionRebase?: boolean;
    toolCatalog?: OpencodeToolDef[];
}, now?: number): Promise<void>;
/** Delete only the expected binding so an overlapping newer turn cannot be removed. */
export declare function deletePersistedConversation(cacheDir: string, sessionKey: string, expectedConversationId?: string): Promise<void>;
/** Full snapshots still held in memory; the store should keep heads only. */
export declare function retainedConversationSnapshotsForTests(): Promise<number>;
export declare function resetConversationPersistenceForTests(): void;
/** Deterministic maintenance barriers/race injection; not a request-path API. */
export declare function setConversationPersistenceHookForTests(hook?: typeof testHook): void;
export declare function waitForConversationMaintenanceForTests(cacheDir: string, now?: number): Promise<void>;
export {};
