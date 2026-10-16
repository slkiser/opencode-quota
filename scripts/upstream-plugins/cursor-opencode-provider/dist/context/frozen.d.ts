import { type BuildRequestContextInput } from "./build.js";
export declare const MAX_FROZEN_REQUEST_CONTEXTS = 256;
/** Frozen stable RequestContext base for this conversation, if any. */
export declare function getFrozenRequestContext(conversationId: string): Record<string, unknown> | undefined;
/** Replace the frozen stable base, stripping any live capability fields. */
export declare function setFrozenRequestContext(conversationId: string, context: Record<string, unknown>): void;
/** Drop a conversation's frozen RequestContext (compaction / binding reset). */
export declare function clearFrozenRequestContext(conversationId: string): void;
/**
 * Move a stable workspace base across a conversation-id reset.
 *
 * Compaction changes Cursor's state/checkpoint identity, not the OpenCode
 * workspace. Preserve the expensive base and the prior materialized bytes as a
 * comparison seed; getOrBuildRequestContext still rediscovers live capability
 * overlays (then epoch-holds them) and only reuses the complete context when
 * those bytes also match.
 */
export declare function transferFrozenRequestContext(previousConversationId: string, nextConversationId: string): boolean;
/** Test helper — wipe all frozen contexts. */
export declare function resetFrozenRequestContextsForTests(): void;
/**
 * Return a stable-base + live-overlay RequestContext for `conversationId`.
 * The base is built once; capability sections are rediscovered every Run
 * and then epoch-held.
 */
export declare function getOrBuildRequestContext(conversationId: string, input: BuildRequestContextInput, opts?: {
    refresh?: boolean;
}): Promise<{
    context: Record<string, unknown>;
    reused: boolean;
}>;
