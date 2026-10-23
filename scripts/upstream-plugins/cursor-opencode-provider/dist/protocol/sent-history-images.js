import { createHash } from "node:crypto";
// Content hashes of the history images a session's Cursor conversation holds, so
// growing history does not re-upload old screenshots. Each set belongs to one
// checkpoint: a Run skips an image only when it sends exactly that checkpoint.
/** Mirrors MAX_TURN_STATE_SESSIONS. */
const MAX_SESSIONS = 256;
const MAX_IMAGES_PER_SESSION = 256;
/** A stopped or failed turn leaves the next Run on one of its intermediate checkpoints. */
const MAX_CHECKPOINTS_PER_SESSION = 32;
/** Newest first. */
const heldBySession = new Map();
export function checkpointFingerprint(checkpoint) {
    return createHash("sha256").update(checkpoint).digest("hex");
}
function newest(hashes) {
    const unique = [...new Set([...hashes].reverse())].reverse();
    return unique.slice(Math.max(0, unique.length - MAX_IMAGES_PER_SESSION));
}
function touch(sessionKey, entries) {
    heldBySession.delete(sessionKey);
    if (entries.length === 0)
        return;
    heldBySession.set(sessionKey, entries.slice(0, MAX_CHECKPOINTS_PER_SESSION));
    while (heldBySession.size > MAX_SESSIONS) {
        const oldest = heldBySession.keys().next().value;
        if (!oldest)
            break;
        heldBySession.delete(oldest);
    }
}
function find(sessionKey, conversationId, checkpoint) {
    const entries = heldBySession.get(sessionKey);
    if (!entries)
        return undefined;
    const fingerprint = checkpointFingerprint(checkpoint);
    return entries.find((entry) => entry.conversationId === conversationId && entry.checkpoint === fingerprint);
}
/** The images `checkpoint` is known to hold. */
export function heldHistoryImageHashes(sessionKey, conversationId, checkpoint) {
    const entry = find(sessionKey, conversationId, checkpoint);
    if (!entry)
        return undefined;
    touch(sessionKey, heldBySession.get(sessionKey));
    return new Set(entry.hashes);
}
function recordHeldHistoryImages(sessionKey, conversationId, checkpoint, hashes) {
    if (hashes.length === 0)
        return;
    const entry = { conversationId, checkpoint: checkpointFingerprint(checkpoint), hashes };
    const others = (heldBySession.get(sessionKey) ?? [])
        .filter((other) => other.conversationId !== conversationId || other.checkpoint !== entry.checkpoint);
    touch(sessionKey, [entry, ...others]);
}
export function runHistoryImages(held) {
    return { held: [...(held ?? [])], checkpointed: [], sent: [] };
}
/** `lastArrival`: the last frame arrival once the images are written. */
export function noteHistoryImagesSent(run, hashes, lastArrival = 0) {
    run.sent.push(...hashes.map((hash) => ({ hash, afterArrival: lastArrival })));
}
/**
 * Cursor's checkpoints extend the one the Run started on, so each holds at least what that one held.
 * A checkpoint that arrived before images were written (read only after a host tool's result) holds none of them.
 */
export function noteHistoryImageCheckpoint(run, sessionKey, conversationId, checkpoint, arrival = Infinity) {
    const later = run.sent.findIndex((image) => image.afterArrival >= arrival);
    const earlier = later < 0 ? run.sent.length : later;
    run.checkpointed.push(...run.sent.slice(0, earlier).map((image) => image.hash));
    run.sent = run.sent.slice(earlier);
    recordHeldHistoryImages(sessionKey, conversationId, checkpoint, run.held);
}
/**
 * The turn ended. On a checkpoint of its own, that checkpoint holds what the Run
 * sent before it; without one, nothing the Run sent counts as held.
 */
export function confirmHistoryImagesAtTurnEnd(run, sessionKey, conversationId, checkpoint) {
    if (checkpoint?.length) {
        run.held = newest([...run.held, ...run.checkpointed]);
        recordHeldHistoryImages(sessionKey, conversationId, checkpoint, run.held);
    }
    run.checkpointed = [];
    run.sent = [];
}
/** For the restart snapshot: the set the checkpoint being saved holds. */
export function heldHistoryImagesSnapshot(sessionKey, conversationId, checkpoint) {
    const entry = checkpoint?.length ? find(sessionKey, conversationId, checkpoint) : undefined;
    return entry ? { checkpoint: entry.checkpoint, hashes: [...entry.hashes] } : undefined;
}
export function restoreHeldHistoryImages(sessionKey, conversationId, saved) {
    touch(sessionKey, saved.checkpoint && saved.hashes?.length
        ? [{ conversationId, checkpoint: saved.checkpoint, hashes: newest(saved.hashes) }]
        : []);
}
export function forgetHeldHistoryImages(sessionKey) {
    heldBySession.delete(sessionKey);
}
export function snapshotHeldHistoryImagesForTests(sessionKey) {
    return (heldBySession.get(sessionKey) ?? []).map((entry) => ({ ...entry, hashes: [...entry.hashes] }));
}
export function resetHeldHistoryImagesForTests() {
    heldBySession.clear();
}
