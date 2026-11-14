/**
 * Cursor CLI parity: the server emits `conversation_checkpoint_update` after
 * (and during) a turn. The CLI replaces its local ConversationStateStructure
 * and re-sends that structure as `AgentRunRequest.conversation_state` on the
 * next Run. We mirror that with an in-process store keyed by conversation_id.
 *
 * Checkpoints are kept as opaque protobuf bytes — CLI's structure uses blob-id
 * fields (repeated bytes), not the seed JSON strings we invent on turn 1.
 */
import { type CursorConversationTokenDetails } from "./token-details.js";
import { type OccupancyObservation } from "../checkpoint-occupancy.js";
/** Replace the stored checkpoint for a conversation (CLI handleCheckpoint). */
export declare function setCheckpoint(conversationId: string, bytes: Uint8Array, observation?: OccupancyObservation): void;
/** Private restart metadata, including a candidate followed by a zero-token checkpoint. */
export declare function serializeCheckpointOccupancyGuard(conversationId: string): string | undefined;
export declare function restoreCheckpointOccupancyGuard(conversationId: string, value: string | undefined): void;
/** Token-details-only checkpoint for local persistence; never sent as Run state. */
export declare function getCheckpointOccupancy(conversationId: string): Uint8Array | undefined;
/** Retain only field #5, without duplicating the checkpoint's potentially large blob graph. */
export declare function restoreCheckpointOccupancy(conversationId: string, checkpoint: Uint8Array): void;
/** Last checkpoint for this conversation, if any. */
export declare function getCheckpoint(conversationId: string): Uint8Array | undefined;
/**
 * Token details of the checkpoint a Run sends. The checkpoint that ends a
 * cancelled Run reports `usedTokens=0`; the conversation's context did not
 * shrink, so its last measured occupancy stands in.
 */
export declare function checkpointTokenDetails(conversationId: string, checkpoint: Uint8Array | undefined): CursorConversationTokenDetails | undefined;
/** Drop a conversation's checkpoint (tests / explicit reset). */
export declare function clearCheckpoint(conversationId: string): void;
/** Test helper — wipe all stored checkpoints. */
export declare function resetCheckpointsForTests(): void;
