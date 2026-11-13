/**
 * Cursor CLI parity: the server emits `conversation_checkpoint_update` after
 * (and during) a turn. The CLI replaces its local ConversationStateStructure
 * and re-sends that structure as `AgentRunRequest.conversation_state` on the
 * next Run. We mirror that with an in-process store keyed by conversation_id.
 *
 * Checkpoints are kept as opaque protobuf bytes — CLI's structure uses blob-id
 * fields (repeated bytes), not the seed JSON strings we invent on turn 1.
 */
import { decodeConversationTokenDetails, } from "./token-details.js";
import protobuf from "protobufjs";
import { parseOccupancyGuard, sameOccupancyReading, selectCheckpointOccupancy } from "../checkpoint-occupancy.js";
const byConversationId = new Map();
/** Last checkpoint occupancy above zero, per conversation. */
const occupancyByConversationId = new Map();
const occupancyGuards = new Map();
/** Replace the stored checkpoint for a conversation (CLI handleCheckpoint). */
export function setCheckpoint(conversationId, bytes, observation = {}) {
    if (!conversationId || bytes.length === 0)
        return;
    // Copy so later mutations of the decode buffer can't corrupt the store.
    byConversationId.set(conversationId, Uint8Array.from(bytes));
    const current = decodeConversationTokenDetails(bytes);
    if (!current) {
        // A reset this checkpoint consumes must outlive the Run: a resumed Run has no media of its own.
        if (observation.bypass)
            occupancyGuards.set(conversationId, { ...(occupancyGuards.get(conversationId) ?? { version: 1 }), needsFreshBaseline: true });
        return;
    }
    const previous = decodeConversationTokenDetails(occupancyByConversationId.get(conversationId));
    const selected = selectCheckpointOccupancy(previous, current, occupancyGuards.get(conversationId) ?? { version: 1 }, observation);
    occupancyGuards.set(conversationId, selected.guard);
    if (!selected.hold)
        restoreCheckpointOccupancy(conversationId, bytes);
}
/** Private restart metadata, including a candidate followed by a zero-token checkpoint. */
export function serializeCheckpointOccupancyGuard(conversationId) {
    const guard = occupancyGuards.get(conversationId);
    return guard ? JSON.stringify(guard) : undefined;
}
export function restoreCheckpointOccupancyGuard(conversationId, value) {
    const guard = parseOccupancyGuard(value);
    if (guard)
        occupancyGuards.set(conversationId, guard);
    else
        occupancyGuards.delete(conversationId);
}
/** Token-details-only checkpoint for local persistence; never sent as Run state. */
export function getCheckpointOccupancy(conversationId) {
    return occupancyByConversationId.get(conversationId);
}
/** Retain only field #5, without duplicating the checkpoint's potentially large blob graph. */
export function restoreCheckpointOccupancy(conversationId, checkpoint) {
    const details = decodeConversationTokenDetails(checkpoint);
    if (!details || details.usedTokens <= 0)
        return;
    const reader = protobuf.Reader.create(checkpoint);
    let tokens;
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        if (tag === 42)
            tokens = reader.bytes();
        else
            reader.skipType(tag & 7);
    }
    if (tokens)
        occupancyByConversationId.set(conversationId, protobuf.Writer.create().uint32(42).bytes(tokens).finish());
}
/** Last checkpoint for this conversation, if any. */
export function getCheckpoint(conversationId) {
    return byConversationId.get(conversationId);
}
/**
 * Token details of the checkpoint a Run sends. The checkpoint that ends a
 * cancelled Run reports `usedTokens=0`; the conversation's context did not
 * shrink, so its last measured occupancy stands in.
 */
export function checkpointTokenDetails(conversationId, checkpoint) {
    const details = decodeConversationTokenDetails(checkpoint);
    const pending = occupancyGuards.get(conversationId)?.pending;
    const accepted = decodeConversationTokenDetails(occupancyByConversationId.get(conversationId));
    if (pending && accepted && details && sameOccupancyReading(details, pending.details))
        return { ...accepted, rawUsedTokens: details.usedTokens };
    if (details?.usedTokens !== 0)
        return details;
    return pending && accepted ? { ...accepted, rawUsedTokens: pending.details.usedTokens } : accepted ?? details;
}
/** Drop a conversation's checkpoint (tests / explicit reset). */
export function clearCheckpoint(conversationId) {
    byConversationId.delete(conversationId);
    occupancyByConversationId.delete(conversationId);
    occupancyGuards.delete(conversationId);
}
/** Test helper — wipe all stored checkpoints. */
export function resetCheckpointsForTests() {
    byConversationId.clear();
    occupancyByConversationId.clear();
    occupancyGuards.clear();
}
