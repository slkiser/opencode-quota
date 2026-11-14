import type { ConversationBlobSnapshot } from "./blob-store.js";
import type { OpencodeToolDef } from "./tools.js";
export type PersistedConversation = {
    sessionKey: string;
    conversationId: string;
    updatedAt: number;
    checkpoint?: Uint8Array;
    /** Last measured occupancy, as a token-details-only checkpoint; separate from resumable state. */
    occupancyCheckpoint?: Uint8Array;
    /** Versioned checkpoint measurement confirmation state, independent of Cursor's wire state. */
    occupancyGuard?: string;
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
    /**
     * Host notes the in-progress Run delivered with its own request (encoded like
     * `hostNote`). Its checkpoint holds them; a rebase after a host history
     * rewrite does not, so only that rebase delivers them again.
     */
    runHostNote?: string;
    /** Bounded early-steer delivery receipts for the saved checkpoint. */
    earlySteers?: string;
    /** JSON lost-request record: user text sent on a checkpoint Cursor never advanced. */
    lostRequest?: string;
    /** Content hashes of the history images `sentImagesCheckpoint` holds. */
    sentImageHashes?: string[];
    /** SHA-256 hex of the checkpoint `sentImageHashes` belongs to; without it no image counts as held. */
    sentImagesCheckpoint?: string;
    /** A session-edit-deny reminder may be in this conversation; absent means none was ever sent. */
    sessionEditsDenySent?: boolean;
    /** Bounded CreatePlan write/review receipts for restart reconciliation. */
    planOperations?: string;
};
export type ConversationLoadStatus = "restored" | "missing" | "invalid" | "expired";
export type PersistedConversationLoad = {
    status: ConversationLoadStatus;
    value?: PersistedConversation;
};
type PersistenceTestPhase = "maintenance-start" | "before-quarantine" | "after-quarantine" | "full-decode" | "directory-opened" | "before-write" | "before-invalidate" | "after-invalidate-open";
declare let testHook: ((phase: PersistenceTestPhase, filePath: string) => Promise<void> | void) | undefined;
export declare function conversationCacheDirectoryPath(cacheDir: string): string;
export declare function conversationCacheFilePath(cacheDir: string, sessionKey: string): string;
/** Readiness includes directory permissions only; maintenance never gates hydration. */
export declare function initializeConversationPersistence(cacheDir: string, now?: number): Promise<void>;
export declare function getPersistedConversation(cacheDir: string, sessionKey: string, now?: number): Promise<PersistedConversation | undefined>;
/** Drop this module copy's cached view of a session's snapshot so the next read goes to disk. */
export declare function forgetCachedConversation(cacheDir: string, sessionKey: string): Promise<void>;
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
/**
 * A failed save left the snapshot on disk behind the state it was saving, whichever conversation that snapshot
 * holds: invalidate it so a restart starts from host history instead of resuming it.
 */
export declare function discardPersistedConversation(cacheDir: string, sessionKey: string): Promise<void>;
/** Full snapshots still held in memory; the store should keep heads only. */
export declare function retainedConversationSnapshotsForTests(): Promise<number>;
export declare function resetConversationPersistenceForTests(): void;
/** Deterministic maintenance barriers/race injection; not a request-path API. */
export declare function setConversationPersistenceHookForTests(hook?: typeof testHook): void;
export declare function waitForConversationMaintenanceForTests(cacheDir: string, now?: number): Promise<void>;
export {};
