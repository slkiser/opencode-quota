/**
 * Cursor CLI parity: the server emits `conversation_checkpoint_update` after
 * (and during) a turn. The CLI replaces its local ConversationStateStructure
 * and re-sends that structure as `AgentRunRequest.conversation_state` on the
 * next Run. We mirror that with an in-process store keyed by conversation_id.
 *
 * Checkpoints are kept as opaque protobuf bytes — CLI's structure uses blob-id
 * fields (repeated bytes), not the seed JSON strings we invent on turn 1.
 */
const byConversationId = new Map();
/** Replace the stored checkpoint for a conversation (CLI handleCheckpoint). */
export function setCheckpoint(conversationId, bytes) {
    if (!conversationId || bytes.length === 0)
        return;
    // Copy so later mutations of the decode buffer can't corrupt the store.
    byConversationId.set(conversationId, Uint8Array.from(bytes));
}
/** Last checkpoint for this conversation, if any. */
export function getCheckpoint(conversationId) {
    return byConversationId.get(conversationId);
}
/** Drop a conversation's checkpoint (tests / explicit reset). */
export function clearCheckpoint(conversationId) {
    byConversationId.delete(conversationId);
}
/** Test helper — wipe all stored checkpoints. */
export function resetCheckpointsForTests() {
    byConversationId.clear();
}
