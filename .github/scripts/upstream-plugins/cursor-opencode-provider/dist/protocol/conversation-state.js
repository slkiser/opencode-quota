import { randomUUID } from "node:crypto";
import path from "node:path";
import { hasHostHistoryRewrite, queueConversationStateWrite, settleConversationStateWrites } from "../host-history-rewrite.js";
import { processShared } from "../process-shared.js";
import { trace } from "../debug.js";
import { restoreEarlySteers, serializeEarlySteers } from "../host-steer.js";
import { restoreLostRequest, serializeLostRequest } from "../lost-request.js";
import { restorePlanOperations, serializePlanOperations } from "./plan-operations.js";
import { clearFrozenRequestContext, getFrozenRequestContext, setFrozenRequestContext, } from "../context/frozen.js";
import { boundConversationId, isActiveConversationBinding, MAX_ACTIVE_CONVERSATION_BINDINGS, restoreConversationBinding, sessionIdToUuid, } from "./conversation-bind.js";
import { compactConversationBlobs, restoreConversationBlobs, } from "./blob-store.js";
import { clearCheckpoint, getCheckpoint, getCheckpointOccupancy, restoreCheckpointOccupancy, setCheckpoint, restoreCheckpointOccupancyGuard, serializeCheckpointOccupancyGuard } from "./checkpoint.js";
import { forgetTurnProvenance, getTurnProvenance, parseTurnProvenance, restoreTurnProvenance, serializeTurnProvenance, } from "./turn-provenance.js";
import { heldHistoryImagesSnapshot, restoreHeldHistoryImages } from "./sent-history-images.js";
import { restoreSessionEditsDenySent, sessionEditsDenySent } from "./session-edits.js";
import { deletePersistedConversation, discardPersistedConversation, forgetCachedConversation, getPersistedTurnProvenance, loadPersistedConversation, persistConversation, } from "./conversation-persistence.js";
const copyId = randomUUID();
const snapshots = processShared("conversation-snapshot-generations.v1", () => ({
    next: 0,
    bySession: new Map(),
}));
const snapshotKey = (cacheDir, sessionKey) => JSON.stringify([path.resolve(cacheDir), sessionKey]);
function snapshotRecord(key, sessionKey) {
    let record = snapshots.bySession.get(key);
    if (!record) {
        record = { sessionKey, generation: ++snapshots.next, unsaved: false, queued: new Map(), held: new Map(), reading: 0 };
        snapshots.bySession.set(key, record);
        pruneSnapshotRecords(key);
    }
    return record;
}
function pruneSnapshotRecords(keep) {
    if (snapshots.bySession.size <= MAX_ACTIVE_CONVERSATION_BINDINGS)
        return;
    const idle = [...snapshots.bySession].filter(([key, record]) => key !== keep && record.queued.size === 0
        && record.reading === 0 && boundConversationId(record.sessionKey) === undefined);
    // A failed save's record keeps copies behind off the older snapshot on disk, also once the binding is gone.
    let spareFailed = idle.filter(([, record]) => record.unsaved).length - MAX_ACTIVE_CONVERSATION_BINDINGS;
    for (const [key, record] of idle) {
        if (snapshots.bySession.size <= MAX_ACTIVE_CONVERSATION_BINDINGS)
            return;
        if (record.unsaved && spareFailed-- <= 0)
            continue;
        snapshots.bySession.delete(key);
    }
}
function heldGeneration(key) {
    return snapshots.bySession.get(key)?.held.get(copyId);
}
function holdsLatestSnapshot(key) {
    const record = snapshots.bySession.get(key);
    return !!record && record.held.get(copyId) === record.generation;
}
function queuedWrite(key, otherCopiesOnly) {
    for (const [copy, count] of snapshots.bySession.get(key)?.queued ?? []) {
        if (count > 0 && (!otherCopiesOnly || copy !== copyId))
            return true;
    }
    return false;
}
/** Count a write from when it is requested; record whether it landed. A failed write leaves an older snapshot on disk. */
async function trackedSnapshotWrite(cacheDir, sessionKey, write) {
    const record = snapshotRecord(snapshotKey(cacheDir, sessionKey), sessionKey);
    record.queued.set(copyId, (record.queued.get(copyId) ?? 0) + 1);
    try {
        if (!await write())
            return;
        record.generation = ++snapshots.next;
        record.unsaved = false;
        record.held.set(copyId, record.generation);
    }
    catch (error) {
        // The disk misses this state, but this copy's memory still holds it.
        record.generation = ++snapshots.next;
        record.unsaved = true;
        record.held.set(copyId, record.generation);
        throw error;
    }
    finally {
        const left = (record.queued.get(copyId) ?? 1) - 1;
        if (left > 0)
            record.queued.set(copyId, left);
        else
            record.queued.delete(copyId);
        // Records skipped while queued would otherwise stay past the cap until another record is created.
        pruneSnapshotRecords();
    }
}
const copyStateResets = [];
/** Per-session state this module copy keeps elsewhere, dropped when it accepts a newer state from disk. */
export function onCopyStateReplaced(reset) {
    copyStateResets.push(reset);
}
/**
 * A copy behind the latest state replaces its per-session state with what it could read: a snapshot, or nothing.
 * A copy that served the session before holds a checkpoint without the turns another copy ran since, so without a
 * snapshot to restore it drops that checkpoint and its next Run seeds host history. A copy that never held a
 * generation has no older checkpoint of its own, unless its record was evicted since: so while another copy holds
 * newer state (its save failed, or its writes keep landing), or another copy holds the latest generation (it wrote,
 * restored or adopted it, also without a snapshot) and that snapshot is now unreadable or gone, every copy behind
 * drops its checkpoint.
 */
function replaceCopyState(key, generation, sessionKey, conversationId, newerElsewhere = false) {
    const record = snapshotRecord(key, sessionKey);
    const servedBefore = record.held.has(copyId);
    const heldElsewhere = [...record.held].some(([copy, held]) => copy !== copyId && held === record.generation);
    record.held.set(copyId, generation);
    forgetTurnProvenance(sessionKey);
    for (const reset of copyStateResets)
        reset(sessionKey);
    if (servedBefore || newerElsewhere || heldElsewhere)
        clearCheckpoint(conversationId);
}
export function resetSnapshotGenerationsForTests() {
    snapshots.next = 0;
    snapshots.bySession.clear();
}
export function snapshotGenerationRecordsForTests() {
    return snapshots.bySession.size;
}
/** Restore one OpenCode session before its conversation binding is resolved. */
export async function hydrateConversationState(cacheDir, sessionKey) {
    // Bindings are process-shared but checkpoints and frozen contexts live per module copy (one per
    // Location): a copy behind the latest snapshot any copy saved restores it.
    const key = snapshotKey(cacheDir, sessionKey);
    const bound = boundConversationId(sessionKey);
    let generation = 0;
    let loaded;
    // An unbound session binds its default conversation id next, which a checkpoint of this copy may still hold.
    const conversationId = bound ?? sessionIdToUuid(sessionKey);
    const entryCheckpoint = getCheckpoint(conversationId);
    // A concurrent request moved, created or evicted the binding meanwhile. Unless this copy holds the latest
    // generation, the checkpoint it started with may lack turns another copy ran; one set since is that request's own.
    const bindingMoved = () => {
        if (boundConversationId(sessionKey) === bound)
            return false;
        if (!holdsLatestSnapshot(key) && getCheckpoint(conversationId) === entryCheckpoint)
            clearCheckpoint(conversationId);
        return true;
    };
    for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
        // This copy's own queued writes hold state no newer than its memory; another copy's may.
        if (bound !== undefined && attempt === 0 && holdsLatestSnapshot(key) && !queuedWrite(key, true))
            return undefined;
        await settleConversationStateWrites(cacheDir, sessionKey);
        // An unbound session still restores process-shared state an eviction may have dropped, unless the disk is behind.
        if (bound !== undefined && holdsLatestSnapshot(key))
            return undefined;
        if (snapshots.bySession.get(key)?.unsaved) {
            trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} status=unsaved`);
            if (!bindingMoved() && !holdsLatestSnapshot(key)) {
                replaceCopyState(key, snapshotRecord(key, sessionKey).generation, sessionKey, conversationId, true);
            }
            return undefined;
        }
        try {
            await forgetCachedConversation(cacheDir, sessionKey);
            const record = snapshotRecord(key, sessionKey);
            generation = record.generation;
            record.reading++;
            let read;
            try {
                read = await loadPersistedConversation(cacheDir, sessionKey);
            }
            finally {
                record.reading--;
            }
            // A write that landed or was queued during the read, also this copy's own, may be newer than what was read.
            if (record.generation === generation && !queuedWrite(key, false))
                loaded = read;
        }
        catch (error) {
            // The caller logs I/O failures and continues from host history. Its older
            // checkpoint must not remain eligible, nor may this discard a checkpoint
            // a concurrent request received while the read was pending.
            if (!bindingMoved() && !holdsLatestSnapshot(key) && getCheckpoint(conversationId) === entryCheckpoint) {
                replaceCopyState(key, snapshotRecord(key, sessionKey).generation, sessionKey, conversationId, true);
            }
            throw error;
        }
    }
    if (!loaded) {
        trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} status=still-writing`);
        if (!bindingMoved()) {
            replaceCopyState(key, snapshotRecord(key, sessionKey).generation, sessionKey, conversationId, true);
        }
        return undefined;
    }
    if (bindingMoved())
        return undefined;
    // A concurrent request in this copy already restored this generation.
    if (bound !== undefined && heldGeneration(key) === generation)
        return undefined;
    // This copy was behind: what is on disk (a snapshot, or none after a delete) replaces its per-session state, also
    // once the binding, and maybe the record, were evicted but this copy's per-session state was not.
    const replacing = heldGeneration(key) !== generation;
    if (replacing) {
        if (bound !== undefined)
            replaceCopyState(key, generation, sessionKey, bound);
        // No copy held a generation: state kept for a session this copy never ran (host notes before its first Run)
        // stays, but a checkpoint of the default conversation may lack turns another copy ran.
        else if (!loaded.value && snapshotRecord(key, sessionKey).held.size === 0) {
            clearCheckpoint(conversationId);
            snapshotRecord(key, sessionKey).held.set(copyId, generation);
        }
        else
            replaceCopyState(key, generation, sessionKey, loaded.value?.conversationId ?? conversationId, true);
    }
    const persisted = loaded.value;
    if (!persisted) {
        trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} ` +
            `status=${loaded.status}`);
        return undefined;
    }
    if (bound !== undefined) {
        const current = boundConversationId(sessionKey);
        if (current !== persisted.conversationId) {
            trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} ` +
                `status=superseded bound=${current ?? "none"} saved=${persisted.conversationId}`);
            return undefined;
        }
    }
    else {
        restoreConversationBinding(sessionKey, persisted.conversationId);
        // Process-shared: another copy's live state is newer than the snapshot.
        restoreEarlySteers(sessionKey, persisted.earlySteers);
        restoreLostRequest(sessionKey, persisted.lostRequest);
        restorePlanOperations(sessionKey, persisted.planOperations);
    }
    // Snapshots written before this marker existed came from releases that never sent a deny.
    restoreSessionEditsDenySent(persisted.conversationId, persisted.sessionEditsDenySent === true, replacing);
    if (replacing)
        clearCheckpoint(persisted.conversationId);
    if (persisted.occupancyCheckpoint)
        restoreCheckpointOccupancy(persisted.conversationId, persisted.occupancyCheckpoint);
    restoreCheckpointOccupancyGuard(persisted.conversationId, persisted.occupancyGuard);
    if (persisted.checkpoint)
        setCheckpoint(persisted.conversationId, persisted.checkpoint);
    restoreConversationBlobs(persisted.conversationId, persisted.blobs);
    if (replacing)
        clearFrozenRequestContext(persisted.conversationId);
    setFrozenRequestContext(persisted.conversationId, persisted.requestContext);
    const provenance = persisted.turnProvenance ? parseTurnProvenance(persisted.turnProvenance) : undefined;
    if (provenance?.conversationId === persisted.conversationId)
        restoreTurnProvenance(sessionKey, provenance);
    restoreHeldHistoryImages(sessionKey, persisted.conversationId, {
        checkpoint: persisted.sentImagesCheckpoint,
        hashes: persisted.sentImageHashes,
    });
    trace(`conversation persistence: restored sessionKey=${sessionKey} ` +
        `conversationId=${persisted.conversationId} checkpoint=${persisted.checkpoint?.length ?? 0}B ` +
        `blobs=${persisted.blobs.length} heldImages=${persisted.sentImageHashes?.length ?? 0}` +
        (bound !== undefined ? " binding=shared" : ""));
    return {
        conversationId: persisted.conversationId,
        postCompactionRebase: persisted.postCompactionRebase,
        toolCatalog: structuredClone(persisted.toolCatalog),
        ...(persisted.hostAgent ? { hostAgent: persisted.hostAgent } : {}),
        ...(persisted.systemPromptHash ? { systemPromptHash: persisted.systemPromptHash } : {}),
        ...(persisted.hostNote ? { hostNote: persisted.hostNote } : {}),
        ...(persisted.runHostNote ? { runHostNote: persisted.runHostNote } : {}),
        ...(replacing ? { replacesCopyState: true } : {}),
    };
}
/** Restore only turn provenance when its in-memory entry was evicted. */
export async function hydrateTurnProvenance(cacheDir, sessionKey) {
    if (getTurnProvenance(sessionKey))
        return;
    // The disk misses the latest save, so its provenance predates the turns some copy holds.
    if (snapshots.bySession.get(snapshotKey(cacheDir, sessionKey))?.unsaved)
        return;
    const persisted = await getPersistedTurnProvenance(cacheDir, sessionKey);
    if (!persisted)
        return;
    const provenance = parseTurnProvenance(persisted.turnProvenance);
    if (provenance?.conversationId === persisted.conversationId)
        restoreTurnProvenance(sessionKey, provenance);
}
/**
 * Persist the resumable state at Cursor's TurnEnded, or before it
 * (`runInProgress`) so a Run the host interrupts, or a restart, resumes from
 * the latest checkpoint and still recognizes the step in progress.
 */
export async function persistConversationState(cacheDir, input) {
    await trackedSnapshotWrite(cacheDir, input.sessionKey, () => queueConversationStateWrite(cacheDir, input.sessionKey, async () => {
        // A newer Run may have reset/superseded this conversation while its final
        // frame was still in flight. Never let that late TurnEnded resurrect it.
        if (!isActiveConversationBinding(input.sessionKey, input.conversationId)) {
            trace(`conversation persistence: skipped superseded TurnEnded ` +
                `sessionKey=${input.sessionKey} conversationId=${input.conversationId}`);
            return false;
        }
        try {
            await saveConversationState(cacheDir, input);
        }
        catch (error) {
            // The snapshot left on disk lacks what this save carried: a restart, or a copy that lost track of this failure,
            // must start from host history instead of resuming it. Still in the write lane, so no newer save is invalidated.
            await discardPersistedConversation(cacheDir, input.sessionKey).then(() => trace(`conversation persistence: invalidated older snapshot after failed save sessionKey=${input.sessionKey}`), (discardError) => trace(`conversation persistence: older snapshot kept after failed save sessionKey=${input.sessionKey}: ` +
                String(discardError)));
            throw error;
        }
        return true;
    }));
}
async function saveConversationState(cacheDir, input) {
    const checkpoint = getCheckpoint(input.conversationId);
    const blobCompaction = compactConversationBlobs(input.conversationId, checkpoint, {
        keepInMemory: input.runInProgress,
    });
    const blobs = blobCompaction.blobs;
    const requestContext = getFrozenRequestContext(input.conversationId) ?? input.requestContext;
    const provenance = getTurnProvenance(input.sessionKey);
    const heldImages = heldHistoryImagesSnapshot(input.sessionKey, input.conversationId, checkpoint);
    await persistConversation(cacheDir, {
        sessionKey: input.sessionKey,
        conversationId: input.conversationId,
        checkpoint,
        occupancyCheckpoint: getCheckpointOccupancy(input.conversationId),
        occupancyGuard: serializeCheckpointOccupancyGuard(input.conversationId),
        blobs,
        requestContext,
        toolCatalog: structuredClone(input.toolCatalog ?? []),
        postCompactionRebase: input.postCompactionRebase || hasHostHistoryRewrite(cacheDir, input.sessionKey),
        hostAgent: input.hostAgent,
        systemPromptHash: input.systemPromptHash,
        hostNote: input.hostNote,
        ...(input.runInProgress && input.runHostNote ? { runHostNote: input.runHostNote } : {}),
        earlySteers: serializeEarlySteers(input.sessionKey),
        lostRequest: serializeLostRequest(input.sessionKey),
        planOperations: serializePlanOperations(input.sessionKey),
        ...(heldImages ? { sentImageHashes: heldImages.hashes, sentImagesCheckpoint: heldImages.checkpoint } : {}),
        ...(sessionEditsDenySent(input.conversationId) ? { sessionEditsDenySent: true } : {}),
        ...(provenance?.conversationId === input.conversationId
            ? { turnProvenance: serializeTurnProvenance(provenance) }
            : {}),
    });
    trace(`conversation persistence: saved${input.runInProgress ? " in-progress" : ""} sessionKey=${input.sessionKey} ` +
        `conversationId=${input.conversationId} checkpoint=${checkpoint?.length ?? 0}B ` +
        `blobs=${blobCompaction.beforeCount}->${blobCompaction.afterCount} ` +
        `blobBytes=${blobCompaction.beforeBytes}->${blobCompaction.afterBytes}` +
        (blobCompaction.fallbackReason ? ` compactionFallback=${blobCompaction.fallbackReason}` : ""));
}
export async function clearPersistedConversationState(cacheDir, sessionKey, expectedConversationId) {
    await trackedSnapshotWrite(cacheDir, sessionKey, () => queueConversationStateWrite(cacheDir, sessionKey, async () => {
        await deletePersistedConversation(cacheDir, sessionKey, expectedConversationId);
        return true;
    }));
}
