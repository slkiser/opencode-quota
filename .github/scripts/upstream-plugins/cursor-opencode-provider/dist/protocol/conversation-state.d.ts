import type { OpencodeToolDef } from "./tools.js";
/** Per-session state this module copy keeps elsewhere, dropped when it accepts a newer state from disk. */
export declare function onCopyStateReplaced(reset: (sessionKey: string) => void): void;
export declare function resetSnapshotGenerationsForTests(): void;
export declare function snapshotGenerationRecordsForTests(): number;
/** Restore one OpenCode session before its conversation binding is resolved. */
export declare function hydrateConversationState(cacheDir: string, sessionKey: string): Promise<{
    conversationId: string;
    postCompactionRebase: boolean;
    toolCatalog: OpencodeToolDef[];
    hostAgent?: string;
    systemPromptHash?: string;
    hostNote?: string;
    runHostNote?: string;
    /** Another copy advanced this binding: the snapshot replaces this copy's per-session turn state. */
    replacesCopyState?: true;
} | undefined>;
/** Restore only turn provenance when its in-memory entry was evicted. */
export declare function hydrateTurnProvenance(cacheDir: string, sessionKey: string): Promise<void>;
type ConversationStateSave = {
    sessionKey: string;
    conversationId: string;
    requestContext: Record<string, unknown>;
    toolCatalog?: OpencodeToolDef[];
    postCompactionRebase?: boolean;
    hostAgent?: string;
    systemPromptHash?: string;
    hostNote?: string;
    /** Only with `runInProgress`: notes that Run's own request delivered. */
    runHostNote?: string;
    runInProgress?: boolean;
};
/**
 * Persist the resumable state at Cursor's TurnEnded, or before it
 * (`runInProgress`) so a Run the host interrupts, or a restart, resumes from
 * the latest checkpoint and still recognizes the step in progress.
 */
export declare function persistConversationState(cacheDir: string, input: ConversationStateSave): Promise<void>;
export declare function clearPersistedConversationState(cacheDir: string, sessionKey: string, expectedConversationId?: string): Promise<void>;
export {};
