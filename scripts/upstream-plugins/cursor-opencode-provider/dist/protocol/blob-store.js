/**
 * Cursor CLI keeps conversation blobs in a durable client store (SQLite) across
 * Runs. ConversationStateStructure only holds blob IDs; the server re-fetches
 * them via get_blob on the next turn. Our per-Run session.blobs Map was wiped
 * on stream close, so follow-up gets echoed 32-byte hashes → server JSON.parse
 * fails ("Unexpected token ... is not valid JSON").
 *
 * This store is keyed by conversation_id and survives across Run streams.
 * At a successful TurnEnded it is compacted to the graph reachable from the
 * latest checkpoint, matching Cursor CLI's conversation-export traversal.
 */
import { errorMessage } from "../debug.js";
import { collectReachableConversationBlobIds } from "./blob-reachability.js";
function hex(b) {
    let s = "";
    for (let i = 0; i < b.length; i++)
        s += b[i].toString(16).padStart(2, "0");
    return s;
}
const byConversation = new Map();
function retainedBlobStats(current) {
    let bytes = 0;
    for (const data of current.values())
        bytes += data.length;
    return { count: current.size, bytes };
}
function bucket(conversationId) {
    let m = byConversation.get(conversationId);
    if (!m) {
        m = new Map();
        byConversation.set(conversationId, m);
    }
    return m;
}
export function setConversationBlob(conversationId, blobId, blobData) {
    const key = hex(blobId);
    // Copy so decode buffers can't mutate the store later.
    bucket(conversationId).set(key, Uint8Array.from(blobData));
    return key;
}
export function getConversationBlob(conversationId, blobId) {
    return bucket(conversationId).get(hex(blobId));
}
export function conversationBlobCount(conversationId) {
    return byConversation.get(conversationId)?.size ?? 0;
}
/**
 * Measure the checkpoint-reachable blob graph without mutating the store.
 * Incomplete graphs conservatively report the complete retained bucket, since
 * that is what the KV channel may have to serve if the checkpoint is used.
 */
export function inspectConversationBlobGraph(conversationId, checkpoint) {
    const current = byConversation.get(conversationId) ?? new Map();
    const retainedStats = (fallbackReason) => ({
        ...retainedBlobStats(current),
        complete: fallbackReason === undefined,
        ...(fallbackReason ? { fallbackReason } : {}),
    });
    if (!checkpoint?.length)
        return retainedStats("checkpoint unavailable");
    try {
        const reachable = collectReachableConversationBlobIds(checkpoint, (id) => {
            const stored = current.get(hex(id));
            if (stored)
                return stored;
            return isBlobIdHash(id) ? undefined : id;
        });
        let count = 0;
        let bytes = 0;
        for (const id of reachable) {
            const data = current.get(id);
            if (!data)
                continue;
            count++;
            bytes += data.length;
        }
        return { count, bytes, complete: true };
    }
    catch (error) {
        return retainedStats(errorMessage(error));
    }
}
/** Copy all durable blobs so a completed turn can be persisted atomically. */
export function snapshotConversationBlobs(conversationId) {
    return [...(byConversation.get(conversationId) ?? [])].map(([id, data]) => ({
        id,
        data: Uint8Array.from(data),
    }));
}
/**
 * Keep only blobs reachable from the latest checkpoint and snapshot them.
 * Malformed/unknown state or a missing referenced hash falls back to retaining
 * every blob: cache size must never come at the cost of restart correctness.
 */
export function compactConversationBlobs(conversationId, checkpoint) {
    const current = byConversation.get(conversationId) ?? new Map();
    const before = retainedBlobStats(current);
    const beforeCount = before.count;
    const beforeBytes = before.bytes;
    const fallback = (reason) => ({
        blobs: snapshotConversationBlobs(conversationId),
        beforeCount,
        beforeBytes,
        afterCount: beforeCount,
        afterBytes: beforeBytes,
        compacted: false,
        fallbackReason: reason,
    });
    if (!checkpoint?.length)
        return fallback("checkpoint unavailable");
    try {
        const reachable = collectReachableConversationBlobIds(checkpoint, (id) => {
            const stored = current.get(hex(id));
            if (stored)
                return stored;
            // Cursor occasionally uses short literal content as its own id.
            return isBlobIdHash(id) ? undefined : id;
        });
        const retained = new Map([...current].filter(([id]) => reachable.has(id)));
        if (retained.size > 0)
            byConversation.set(conversationId, retained);
        else
            byConversation.delete(conversationId);
        const afterBytes = [...retained.values()].reduce((total, data) => total + data.length, 0);
        return {
            blobs: snapshotConversationBlobs(conversationId),
            beforeCount,
            beforeBytes,
            afterCount: retained.size,
            afterBytes,
            compacted: true,
        };
    }
    catch (error) {
        return fallback(errorMessage(error));
    }
}
/** Replace the in-memory blob bucket when restoring a persisted conversation. */
export function restoreConversationBlobs(conversationId, blobs) {
    if (!conversationId)
        return;
    const restored = new Map();
    for (const blob of blobs) {
        if (!/^(?:[0-9a-f]{2})+$/i.test(blob.id))
            continue;
        restored.set(blob.id.toLowerCase(), Uint8Array.from(blob.data));
    }
    if (restored.size > 0)
        byConversation.set(conversationId, restored);
    else
        byConversation.delete(conversationId);
}
/** Drop all blobs for a conversation (compaction conversation reset). */
export function clearConversationBlobs(conversationId) {
    byConversation.delete(conversationId);
}
/** SHA-256 content hashes are 32 non-text bytes — never echo those as content. */
export function isBlobIdHash(blobId) {
    if (blobId.length !== 32)
        return false;
    // Content-as-id payloads can also be 32 bytes (short JSON). Real hashes are
    // binary; if every byte is printable ASCII/UTF-8 text, treat as content.
    for (let i = 0; i < blobId.length; i++) {
        const b = blobId[i];
        if (b < 0x09 || (b > 0x0d && b < 0x20) || b > 0x7e)
            return true;
    }
    return false;
}
export function resetConversationBlobsForTests() {
    byConversation.clear();
}
