import type { OpencodeToolDef } from "./tools.js";
/** Restore one OpenCode session before its conversation binding is resolved. */
export declare function hydrateConversationState(cacheDir: string, sessionKey: string): Promise<{
    conversationId: string;
    postCompactionRebase: boolean;
    toolCatalog: OpencodeToolDef[];
    hostAgent?: string;
    systemPromptHash?: string;
} | undefined>;
/** Restore only turn provenance when its in-memory entry was evicted. */
export declare function hydrateTurnProvenance(cacheDir: string, sessionKey: string): Promise<void>;
/** Persist the complete resumable state only after Cursor confirms TurnEnded. */
export declare function persistConversationState(cacheDir: string, input: {
    sessionKey: string;
    conversationId: string;
    requestContext: Record<string, unknown>;
    toolCatalog?: OpencodeToolDef[];
    postCompactionRebase?: boolean;
    hostAgent?: string;
    systemPromptHash?: string;
}): Promise<void>;
export declare function clearPersistedConversationState(cacheDir: string, sessionKey: string, expectedConversationId?: string): Promise<void>;
