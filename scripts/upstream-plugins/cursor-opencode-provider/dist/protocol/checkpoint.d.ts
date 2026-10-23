/**
 * Cursor CLI parity: the server emits `conversation_checkpoint_update` after
 * (and during) a turn. The CLI replaces its local ConversationStateStructure
 * and re-sends that structure as `AgentRunRequest.conversation_state` on the
 * next Run. We mirror that with an in-process store keyed by conversation_id.
 *
 * Checkpoints are kept as opaque protobuf bytes — CLI's structure uses blob-id
 * fields (repeated bytes), not the seed JSON strings we invent on turn 1.
 */
/** Replace the stored checkpoint for a conversation (CLI handleCheckpoint). */
export declare function setCheckpoint(conversationId: string, bytes: Uint8Array): void;
/** Last checkpoint for this conversation, if any. */
export declare function getCheckpoint(conversationId: string): Uint8Array | undefined;
/** Drop a conversation's checkpoint (tests / explicit reset). */
export declare function clearCheckpoint(conversationId: string): void;
/** Test helper — wipe all stored checkpoints. */
export declare function resetCheckpointsForTests(): void;
