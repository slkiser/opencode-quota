import { createHash } from "node:crypto";
import { clearCheckpoint } from "./checkpoint.js";
import { clearConversationBlobs } from "./blob-store.js";
import { transferFrozenRequestContext } from "../context/frozen.js";
/**
 * OpenCode session key → active Cursor conversation_id.
 *
 * Normally the binding is the deterministic UUID from the OpenCode session id
 * (CLI-shaped sticky conversation). Compaction/summary turns mint a fresh id
 * and drop the prior checkpoint + blobs so Cursor no longer bills the old
 * cached conversation against OpenCode's newly compacted prompt.
 */
const activeBySession = new Map();
// A compaction id cannot be reconstructed from its host session key. Keep its
// tiny binding even when the recent-session index soft-evicts that session.
const remintedBySession = new Map();
export const MAX_ACTIVE_CONVERSATION_BINDINGS = 256;
function rememberConversation(sessionKey, conversationId) {
    if (conversationId === sessionIdToUuid(sessionKey))
        remintedBySession.delete(sessionKey);
    else
        remintedBySession.set(sessionKey, conversationId);
    // Map insertion order is the LRU order. Refresh existing sessions on use.
    activeBySession.delete(sessionKey);
    activeBySession.set(sessionKey, conversationId);
    while (activeBySession.size > MAX_ACTIVE_CONVERSATION_BINDINGS) {
        const oldest = activeBySession.entries().next().value;
        if (!oldest)
            break;
        activeBySession.delete(oldest[0]);
        // Evict only the lookup pointer. The checkpoint may still be needed by a
        // held Run, and a returning session can hydrate its durable binding before
        // resolving another turn. Compaction/reset owns deletion of opaque state.
    }
}
export function resetConversationBindingsForTests() {
    activeBySession.clear();
    remintedBySession.clear();
}
export function hasConversationBinding(sessionKey) {
    return activeBySession.has(sessionKey) || remintedBySession.has(sessionKey);
}
export function isActiveConversationBinding(sessionKey, conversationId) {
    return (activeBySession.get(sessionKey) ?? remintedBySession.get(sessionKey)
        ?? sessionIdToUuid(sessionKey)) === conversationId;
}
/** Restore a validated durable binding before resolving the next Run. */
export function restoreConversationBinding(sessionKey, conversationId) {
    if (!sessionKey || !conversationId)
        return;
    rememberConversation(sessionKey, conversationId);
}
/** Deterministic UUID (version-4 shape) from an arbitrary session key. */
export function sessionIdToUuid(sessionId) {
    const hash = createHash("sha256").update(`cursor-opencode-provider:conv:${sessionId}`).digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/**
 * Stable Cursor conversation group for one OpenCode session.
 *
 * Individual conversation ids are reminted for compaction/rebase boundaries,
 * while the native Cursor CLI keeps the enclosing agent-store group stable.
 * With no host session identity, the current conversation is the only safe
 * grouping scope available.
 */
export function resolveConversationGroupId(sessionKey, conversationId) {
    return sessionKey ? sessionIdToUuid(sessionKey) : conversationId;
}
/** Current Cursor conversation_id for an OpenCode session key, creating the default binding if needed. */
export function peekConversationId(sessionKey) {
    let id = activeBySession.get(sessionKey) ?? remintedBySession.get(sessionKey);
    if (!id) {
        id = sessionIdToUuid(sessionKey);
    }
    rememberConversation(sessionKey, id);
    return id;
}
/**
 * Resolve the Cursor conversation_id for this OpenCode session.
 * When `reset` is true (compaction/summary), discard prior Cursor state and
 * mint a new id so TurnEnded cache_read cannot keep overflowing OpenCode.
 */
export function bindConversationId(sessionKey, opts) {
    if (opts?.ephemeral) {
        return { conversationId: crypto.randomUUID(), reset: false };
    }
    if (!sessionKey) {
        return { conversationId: crypto.randomUUID(), reset: !!opts?.reset };
    }
    if (opts?.reset) {
        const previousId = activeBySession.get(sessionKey) ?? remintedBySession.get(sessionKey)
            ?? sessionIdToUuid(sessionKey);
        const conversationId = crypto.randomUUID();
        clearCheckpoint(previousId);
        clearConversationBlobs(previousId);
        transferFrozenRequestContext(previousId, conversationId);
        rememberConversation(sessionKey, conversationId);
        return { conversationId, reset: true, previousId };
    }
    return { conversationId: peekConversationId(sessionKey), reset: false };
}
