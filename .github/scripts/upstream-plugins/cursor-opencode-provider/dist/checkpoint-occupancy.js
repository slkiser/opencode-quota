import { currentCursorTokenBreakdown } from "./protocol/token-details.js";
function categories(details) {
    const breakdown = currentCursorTokenBreakdown(details);
    if (!breakdown || !Number.isSafeInteger(details.usedTokens) || !Number.isSafeInteger(details.maxTokens)
        || details.usedTokens <= 0 || details.maxTokens <= 0)
        return undefined;
    const result = new Map();
    let total = 0;
    for (const category of breakdown.categories) {
        if (!category.id || result.has(category.id) || !Number.isSafeInteger(category.estimatedTokens)
            || category.estimatedTokens < 0 || (category.characterCount !== undefined
            && (!Number.isSafeInteger(category.characterCount) || category.characterCount < 0)))
            return undefined;
        result.set(category.id, category);
        total += category.estimatedTokens;
    }
    const conversation = result.get("conversation");
    return total === details.usedTokens && conversation && (conversation.characterCount ?? 0) > 0
        ? result : undefined;
}
function equalCategory(a, b) {
    return a.label === b.label && a.estimatedTokens === b.estimatedTokens && a.characterCount === b.characterCount;
}
/** Match an unexplained conversation-only jump; missing evidence always admits the raw reading. */
export function isUnexplainedOccupancyJump(previous, current) {
    if (previous.maxTokens !== current.maxTokens || current.usedTokens < previous.usedTokens * 1.75)
        return false;
    const before = categories(previous);
    const after = categories(current);
    if (!before || !after || before.size !== after.size)
        return false;
    for (const [id, category] of before) {
        const next = after.get(id);
        if (!next || (id !== "conversation" && !equalCategory(category, next)))
            return false;
    }
    const a = before.get("conversation");
    const b = after.get("conversation");
    const charsBefore = a.characterCount;
    const charsAfter = b.characterCount;
    // A substantial shrink can mean a summary, model change or a different window.
    return a.estimatedTokens > 0 && charsAfter >= charsBefore * 0.8 && charsAfter <= charsBefore * 1.25
        && b.estimatedTokens * charsBefore >= a.estimatedTokens * charsAfter * 1.5;
}
export function sameOccupancyReading(a, b) {
    const before = categories(a);
    const after = categories(b);
    return a.usedTokens === b.usedTokens && a.maxTokens === b.maxTokens
        && !!before && !!after && before.size === after.size
        && [...before].every(([id, value]) => { const other = after.get(id); return !!other && equalCategory(value, other); });
}
export function selectCheckpointOccupancy(previous, current, guard, observation = {}) {
    const modelChanged = observation.model !== undefined && guard.model !== undefined && guard.model !== observation.model;
    const next = { version: 1, model: observation.model ?? guard.model };
    const resetBaseline = modelChanged || observation.bypass || guard.needsFreshBaseline;
    // Zero is a cancellation marker, not an independent positive measurement.
    if (current.usedTokens <= 0)
        return { hold: false, guard: resetBaseline ? { ...next, needsFreshBaseline: true } : guard };
    if (resetBaseline || !previous || !isUnexplainedOccupancyJump(previous, current))
        return { hold: false, guard: next };
    const pending = guard.pending;
    if (pending && (
    // A new host observation can confirm an unchanged count. Duplicate pairs
    // within one observation cannot. This also bounds a hold across restarts.
    (observation.boundary !== undefined && observation.boundary !== pending.boundary)
        || (!sameOccupancyReading(pending.details, current)
            && current.usedTokens >= pending.details.usedTokens * 0.8 && current.usedTokens <= pending.details.usedTokens * 1.25)))
        return { hold: false, guard: next };
    return { hold: true, guard: { ...next, pending: { details: current, boundary: pending?.boundary ?? observation.boundary } } };
}
/** Guard metadata is private cache data; reject malformed or unbounded records. */
export function parseOccupancyGuard(value) {
    if (!value || value.length > 64 * 1024)
        return undefined;
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1)
            return undefined;
        const model = "model" in parsed ? parsed.model : undefined;
        if (model !== undefined && (typeof model !== "string" || model.length > 2_000))
            return undefined;
        const next = { version: 1, ...(typeof model === "string" ? { model } : {}) };
        if ("needsFreshBaseline" in parsed) {
            if (parsed.needsFreshBaseline !== true)
                return undefined;
            next.needsFreshBaseline = true;
        }
        if (!("pending" in parsed) || parsed.pending === undefined)
            return next;
        const pending = parsed.pending;
        if (!pending || typeof pending !== "object" || !("details" in pending))
            return undefined;
        const boundary = "boundary" in pending ? pending.boundary : undefined;
        if (boundary !== undefined && (typeof boundary !== "string" || boundary.length > 2_000))
            return undefined;
        const details = pending.details;
        if (!details || typeof details !== "object" || !("usedTokens" in details) || !("maxTokens" in details)
            || !Number.isSafeInteger(details.usedTokens) || !Number.isSafeInteger(details.maxTokens)
            || !("breakdown" in details) || !details.breakdown || typeof details.breakdown !== "object")
            return undefined;
        const breakdown = details.breakdown;
        if (!("categories" in breakdown) || !Array.isArray(breakdown.categories) || breakdown.categories.length > 128
            || !("totalUsedTokens" in breakdown) || !("maxTokens" in breakdown))
            return undefined;
        const items = [];
        for (const item of breakdown.categories) {
            if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.label !== "string"
                || typeof item.estimatedTokens !== "number" || (item.characterCount !== undefined && typeof item.characterCount !== "number"))
                return undefined;
            items.push({ id: item.id, label: item.label, estimatedTokens: item.estimatedTokens,
                ...(item.characterCount !== undefined ? { characterCount: item.characterCount } : {}) });
        }
        if (typeof details.usedTokens !== "number" || typeof details.maxTokens !== "number"
            || typeof breakdown.totalUsedTokens !== "number" || typeof breakdown.maxTokens !== "number")
            return undefined;
        const candidate = { usedTokens: details.usedTokens, maxTokens: details.maxTokens,
            breakdown: { totalUsedTokens: breakdown.totalUsedTokens, maxTokens: breakdown.maxTokens, categories: items } };
        if (!categories(candidate))
            return undefined;
        return { ...next, pending: { details: candidate, ...(typeof boundary === "string" ? { boundary } : {}) } };
    }
    catch {
        return undefined;
    }
}
