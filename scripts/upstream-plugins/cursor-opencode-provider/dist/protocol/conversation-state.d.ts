import type { OpencodeToolDef } from "./tools.js";
/** Restore one OpenCode session before its conversation binding is resolved. */
export declare function hydrateConversationState(cacheDir: string, sessionKey: string): Promise<{
    conversationId: string;
    postCompactionRebase: boolean;
    toolCatalog: OpencodeToolDef[];
    hostAgent?: string;
    systemPromptHash?: string;
    hostNote?: string;
} | undefined>;
/** Restore only turn provenance when its in-memory entry was evicted. */
export declare function hydrateTurnProvenance(cacheDir: string, sessionKey: string): Promise<void>;
/**
 * Persist the resumable state at Cursor's TurnEnded, or before it
 * (`runInProgress`) so a Run the host interrupts, or a restart, resumes from
 * the latest checkpoint and still recognizes the step in progress.
 */
export declare function persistConversationState(cacheDir: string, input: {
    sessionKey: string;
    conversationId: string;
    requestContext: Record<string, unknown>;
    toolCatalog?: OpencodeToolDef[];
    postCompactionRebase?: boolean;
    hostAgent?: string;
    systemPromptHash?: string;
    hostNote?: string;
    runInProgress?: boolean;
}): Promise<void>;
export declare function clearPersistedConversationState(cacheDir: string, sessionKey: string, expectedConversationId?: string): Promise<void>;
