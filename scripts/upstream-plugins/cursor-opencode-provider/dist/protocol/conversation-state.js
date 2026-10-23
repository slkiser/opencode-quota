import { trace } from "../debug.js";
import { restoreEarlySteers, serializeEarlySteers } from "../host-steer.js";
import { restoreLostRequest, serializeLostRequest } from "../lost-request.js";
import { getFrozenRequestContext, setFrozenRequestContext, } from "../context/frozen.js";
import { hasConversationBinding, isActiveConversationBinding, restoreConversationBinding, } from "./conversation-bind.js";
import { compactConversationBlobs, restoreConversationBlobs, } from "./blob-store.js";
import { getCheckpoint, setCheckpoint } from "./checkpoint.js";
import { getTurnProvenance, parseTurnProvenance, restoreTurnProvenance, serializeTurnProvenance, } from "./turn-provenance.js";
import { heldHistoryImagesSnapshot, restoreHeldHistoryImages } from "./sent-history-images.js";
import { deletePersistedConversation, getPersistedTurnProvenance, loadPersistedConversation, persistConversation, } from "./conversation-persistence.js";
/** Restore one OpenCode session before its conversation binding is resolved. */
export async function hydrateConversationState(cacheDir, sessionKey) {
    if (hasConversationBinding(sessionKey))
        return undefined;
    const loaded = await loadPersistedConversation(cacheDir, sessionKey);
    const persisted = loaded.value;
    if (!persisted) {
        trace(`conversation persistence: hydration skipped sessionKey=${sessionKey} ` +
            `status=${loaded.status}`);
        return undefined;
    }
    restoreConversationBinding(sessionKey, persisted.conversationId);
    restoreEarlySteers(sessionKey, persisted.earlySteers);
    restoreLostRequest(sessionKey, persisted.lostRequest);
    if (persisted.checkpoint)
        setCheckpoint(persisted.conversationId, persisted.checkpoint);
    restoreConversationBlobs(persisted.conversationId, persisted.blobs);
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
        `blobs=${persisted.blobs.length} heldImages=${persisted.sentImageHashes?.length ?? 0}`);
    return {
        conversationId: persisted.conversationId,
        postCompactionRebase: persisted.postCompactionRebase,
        toolCatalog: structuredClone(persisted.toolCatalog),
        ...(persisted.hostAgent ? { hostAgent: persisted.hostAgent } : {}),
        ...(persisted.systemPromptHash ? { systemPromptHash: persisted.systemPromptHash } : {}),
        ...(persisted.hostNote ? { hostNote: persisted.hostNote } : {}),
    };
}
/** Restore only turn provenance when its in-memory entry was evicted. */
export async function hydrateTurnProvenance(cacheDir, sessionKey) {
    if (getTurnProvenance(sessionKey))
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
    // A newer Run may have reset/superseded this conversation while its final
    // frame was still in flight. Never let that late TurnEnded resurrect it.
    if (!isActiveConversationBinding(input.sessionKey, input.conversationId)) {
        trace(`conversation persistence: skipped superseded TurnEnded ` +
            `sessionKey=${input.sessionKey} conversationId=${input.conversationId}`);
        return;
    }
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
        blobs,
        requestContext,
        toolCatalog: structuredClone(input.toolCatalog ?? []),
        postCompactionRebase: input.postCompactionRebase,
        hostAgent: input.hostAgent,
        systemPromptHash: input.systemPromptHash,
        hostNote: input.hostNote,
        earlySteers: serializeEarlySteers(input.sessionKey),
        lostRequest: serializeLostRequest(input.sessionKey),
        ...(heldImages ? { sentImageHashes: heldImages.hashes, sentImagesCheckpoint: heldImages.checkpoint } : {}),
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
    await deletePersistedConversation(cacheDir, sessionKey, expectedConversationId);
}
