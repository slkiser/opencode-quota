/**
 * Epoch-hold live RequestContext overlay lists (subagents, plugins).
 *
 * Same policy as the tool catalog: first nonempty freeze is UTF-16 by id,
 * equal ids keep frozen bytes (including content), new ids append at the
 * tail, shrink keeps the epoch advertisement. Discovery still runs every
 * Run; this only canonicalizes what is advertised.
 */
export const MAX_OVERLAY_HOLDS = 256;
const byConversationId = new Map();
function utf16(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function inFixedOrder(items, idOf) {
    return items
        .map((item) => ({ ...item }))
        .sort((left, right) => utf16(idOf(left), idOf(right)));
}
function holdList(cached, incoming, idOf) {
    const orderedIncoming = inFixedOrder(incoming, idOf);
    if (!cached || cached.length === 0)
        return orderedIncoming;
    const cachedIds = new Set(cached.map(idOf));
    const hasNew = orderedIncoming.some((item) => !cachedIds.has(idOf(item)));
    if (!hasNew)
        return cached;
    const newcomers = inFixedOrder(orderedIncoming.filter((item) => !cachedIds.has(idOf(item))), idOf);
    return [...cached, ...newcomers];
}
function remember(conversationId, hold) {
    const stored = {
        subagents: structuredClone(hold.subagents),
        plugins: structuredClone(hold.plugins),
    };
    byConversationId.delete(conversationId);
    byConversationId.set(conversationId, stored);
    while (byConversationId.size > MAX_OVERLAY_HOLDS) {
        const oldest = byConversationId.keys().next().value;
        if (!oldest)
            break;
        byConversationId.delete(oldest);
    }
    return stored;
}
/** Merge live discovery into the conversation overlay epoch. */
export function holdCapabilityOverlay(conversationId, live) {
    if (!conversationId) {
        return {
            subagents: inFixedOrder(live.subagents, (agent) => agent.name),
            plugins: inFixedOrder(live.plugins, (plugin) => plugin.id),
        };
    }
    const cached = byConversationId.get(conversationId);
    const next = {
        subagents: holdList(cached?.subagents, live.subagents, (agent) => agent.name),
        plugins: holdList(cached?.plugins, live.plugins, (plugin) => plugin.id),
    };
    if (next.subagents.length === 0 && next.plugins.length === 0) {
        byConversationId.delete(conversationId);
        return next;
    }
    return remember(conversationId, next);
}
export function clearOverlayHold(conversationId) {
    byConversationId.delete(conversationId);
}
export function transferOverlayHold(previousConversationId, nextConversationId) {
    if (!previousConversationId || !nextConversationId)
        return;
    const hold = byConversationId.get(previousConversationId);
    byConversationId.delete(previousConversationId);
    byConversationId.delete(nextConversationId);
    if (!hold)
        return;
    remember(nextConversationId, hold);
}
export function resetOverlayHoldsForTests() {
    byConversationId.clear();
}
