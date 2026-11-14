import path from "node:path";
import { processShared } from "./process-shared.js";
import { getPersistedConversation, persistConversation } from "./protocol/conversation-persistence.js";
const state = processShared("host-history-rewrite.v1", () => ({
    rewrites: new Map(),
    writes: new Map(),
}));
const keyFor = (cacheDir, sessionKey) => JSON.stringify([path.resolve(cacheDir), sessionKey]);
export function queueConversationStateWrite(cacheDir, sessionKey, write) {
    const key = keyFor(cacheDir, sessionKey);
    const next = (state.writes.get(key) ?? Promise.resolve()).catch(() => { }).then(write);
    state.writes.set(key, next);
    void next.finally(() => {
        if (state.writes.get(key) === next)
            state.writes.delete(key);
    }).catch(() => { });
    return next;
}
/** Wait until every snapshot write queued for the session, by any module copy, has finished or failed. */
export function settleConversationStateWrites(cacheDir, sessionKey) {
    return (state.writes.get(keyFor(cacheDir, sessionKey)) ?? Promise.resolve()).then(() => { }, () => { });
}
export function hasHostHistoryRewrite(cacheDir, sessionKey) {
    return state.rewrites.get(keyFor(cacheDir, sessionKey))?.pending === true;
}
function saveRewrite(cacheDir, sessionKey, rewrite) {
    if (rewrite.durable)
        return Promise.resolve();
    return rewrite.saving ??= queueConversationStateWrite(cacheDir, sessionKey, async () => {
        const saved = await getPersistedConversation(cacheDir, sessionKey);
        // With no saved Cursor state, restart already starts from host history.
        // Do not manufacture an incomplete frozen RequestContext as a tombstone.
        // Any later held-Run save is serialized here and carries the pending flag.
        if (saved)
            await persistConversation(cacheDir, { ...saved, postCompactionRebase: true });
        rewrite.durable = true;
    }).finally(() => { rewrite.saving = undefined; });
}
/** Only a committed compaction event calls this; preparing a summary does not. */
export function noteHostHistoryRewrite(cacheDir, sessionKey, eventID) {
    const key = keyFor(cacheDir, sessionKey);
    let rewrite = state.rewrites.get(key);
    if (!rewrite || rewrite.eventID !== eventID) {
        rewrite = { eventID, pending: true, durable: false };
        state.rewrites.set(key, rewrite);
    }
    return saveRewrite(cacheDir, sessionKey, rewrite);
}
/** Await the durable receipt; a failed save is retried by the next request. */
export async function awaitHostHistoryRewrite(cacheDir, sessionKey) {
    const rewrite = state.rewrites.get(keyFor(cacheDir, sessionKey));
    if (!rewrite?.pending)
        return false;
    await saveRewrite(cacheDir, sessionKey, rewrite);
    return true;
}
/** Consumed receipts kept so a late copy of their event cannot ask for a second rebase. */
export const MAX_CONSUMED_HOST_HISTORY_REWRITES = 256;
/** Consume only after the provider has replaced the old conversation binding. */
export function acknowledgeHostHistoryRewrite(cacheDir, sessionKey) {
    const key = keyFor(cacheDir, sessionKey);
    const rewrite = state.rewrites.get(key);
    if (!rewrite)
        return;
    rewrite.pending = false;
    // Keep the newest consumed receipts as tombstones; never drop a pending one.
    state.rewrites.delete(key);
    state.rewrites.set(key, rewrite);
    let consumed = 0;
    for (const entry of state.rewrites.values())
        if (!entry.pending)
            consumed++;
    for (const [other, entry] of state.rewrites) {
        if (consumed <= MAX_CONSUMED_HOST_HISTORY_REWRITES)
            break;
        if (entry.pending || entry.saving)
            continue;
        state.rewrites.delete(other);
        consumed--;
    }
}
export function resetHostHistoryRewritesForTests() {
    state.rewrites.clear();
    state.writes.clear();
}
