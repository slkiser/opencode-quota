export declare const MAX_ACTIVE_CONVERSATION_BINDINGS = 256;
export declare function resetConversationBindingsForTests(): void;
export declare function hasConversationBinding(sessionKey: string): boolean;
export declare function isActiveConversationBinding(sessionKey: string, conversationId: string): boolean;
/** Restore a validated durable binding before resolving the next Run. */
export declare function restoreConversationBinding(sessionKey: string, conversationId: string): void;
/** Deterministic UUID (version-4 shape) from an arbitrary session key. */
export declare function sessionIdToUuid(sessionId: string): string;
/**
 * Stable Cursor conversation group for one OpenCode session.
 *
 * Individual conversation ids are reminted for compaction/rebase boundaries,
 * while the native Cursor CLI keeps the enclosing agent-store group stable.
 * With no host session identity, the current conversation is the only safe
 * grouping scope available.
 */
export declare function resolveConversationGroupId(sessionKey: string | undefined, conversationId: string): string;
/** Current Cursor conversation_id for an OpenCode session key, creating the default binding if needed. */
export declare function peekConversationId(sessionKey: string): string;
/**
 * Resolve the Cursor conversation_id for this OpenCode session.
 * When `reset` is true (compaction/summary), discard prior Cursor state and
 * mint a new id so TurnEnded cache_read cannot keep overflowing OpenCode.
 */
export declare function bindConversationId(sessionKey: string | undefined, opts?: {
    reset?: boolean;
    ephemeral?: boolean;
}): {
    conversationId: string;
    reset: boolean;
    previousId?: string;
};
