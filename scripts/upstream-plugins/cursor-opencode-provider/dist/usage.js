import { currentCursorTokenBreakdown } from "./protocol/token-details.js";
/** Non-negative integer counter from a Cursor `turn_ended` field. */
export function turnEndedCounter(te, key) {
    const value = te[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : 0;
}
export function cursorUsageCountersFromTurnEnded(te) {
    return {
        inputTokens: turnEndedCounter(te, "input_tokens"),
        outputTokens: turnEndedCounter(te, "output_tokens"),
        cacheRead: turnEndedCounter(te, "cache_read"),
        cacheWrite: turnEndedCounter(te, "cache_write"),
        reasoningTokens: turnEndedCounter(te, "reasoning_tokens"),
    };
}
/**
 * Map Cursor counters to AI SDK V3. Cursor's `input_tokens` already includes
 * cache reads/writes, and `output_tokens` already includes reasoning.
 */
export function buildLanguageModelV3UsageFromCounters(counters, options = {}) {
    const rawInput = Math.max(0, Math.trunc(counters.inputTokens));
    const rawOutput = Math.max(0, Math.trunc(counters.outputTokens));
    const rawCacheRead = Math.min(Math.max(0, Math.trunc(counters.cacheRead)), rawInput);
    const rawCacheWrite = Math.min(Math.max(0, Math.trunc(counters.cacheWrite)), rawInput - rawCacheRead);
    const rawReasoning = Math.min(Math.max(0, Math.trunc(counters.reasoningTokens)), rawOutput);
    const contextTotal = options.contextTotalTokens;
    const hasContextTotal = typeof contextTotal === "number" && Number.isFinite(contextTotal) && contextTotal >= 0;
    const total = hasContextTotal ? Math.trunc(contextTotal) : rawInput + rawOutput;
    const output = Math.min(rawOutput, total);
    const input = Math.max(0, total - output);
    // TurnEnded can aggregate several internal model calls, so its absolute input
    // and cache counts can exceed the final checkpoint occupancy. Preserve the
    // cache proportions while normalizing the partition to Cursor's context total.
    const proportionalRead = rawInput > 0
        ? Math.min(input, Math.round(input * rawCacheRead / rawInput))
        : 0;
    const priorContext = options.priorContextTokens;
    const prefixRead = typeof priorContext === "number"
        && Number.isFinite(priorContext)
        && priorContext > 0
        && rawCacheRead >= priorContext
        ? Math.min(input, Math.trunc(priorContext))
        : 0;
    const cacheRead = Math.min(input, Math.max(proportionalRead, prefixRead));
    const cacheWrite = rawInput > 0
        ? Math.min(input - cacheRead, Math.round(input * rawCacheWrite / rawInput))
        : 0;
    const reasoning = rawOutput > 0
        ? Math.min(output, Math.round(output * rawReasoning / rawOutput))
        : 0;
    return {
        inputTokens: {
            total: input,
            noCache: Math.max(input - cacheRead - cacheWrite, 0),
            cacheRead,
            cacheWrite,
        },
        outputTokens: {
            total: output,
            text: Math.max(output - reasoning, 0),
            reasoning,
        },
    };
}
export function buildLanguageModelV3UsageFromTurnEnded(te, options = {}) {
    return buildLanguageModelV3UsageFromCounters(cursorUsageCountersFromTurnEnded(te), options);
}
function usageCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : 0;
}
function usageRatio(part, total) {
    return total > 0 ? `${(part / total * 100).toFixed(1)}%` : "n/a";
}
function categoryTokens(details) {
    return new Map(currentCursorTokenBreakdown(details)?.categories.map((category) => [
        category.id || category.label || "(unnamed)",
        category.estimatedTokens,
    ]) ?? []);
}
/** Compact, parseable category snapshot for checkpoint-by-checkpoint traces. */
export function formatCursorTokenCategories(details) {
    const categories = Object.fromEntries(categoryTokens(details));
    return Object.keys(categories).length > 0 ? JSON.stringify(categories) : "unavailable";
}
/**
 * Explain Cursor's aggregate cache counters using the state visible to this
 * client. `stepStarts` is deliberately not called a model-call count: Cursor
 * does not expose per-model-call cache accounting on the Run stream.
 */
export function formatCursorCacheDiagnostics(counters, current, prior, stats) {
    const rawInput = Math.max(0, Math.trunc(counters.inputTokens));
    const rawRead = Math.min(rawInput, Math.max(0, Math.trunc(counters.cacheRead)));
    const rawWrite = Math.min(rawInput - rawRead, Math.max(0, Math.trunc(counters.cacheWrite)));
    const rawUncached = Math.max(0, rawInput - rawRead - rawWrite);
    const priorCategories = categoryTokens(prior);
    const currentCategories = categoryTokens(current);
    const categoriesComparable = !!currentCursorTokenBreakdown(prior) && !!currentCursorTokenBreakdown(current);
    const categoryDelta = {};
    let sameSizedCategoryTokens = 0;
    if (categoriesComparable) {
        for (const id of new Set([...priorCategories.keys(), ...currentCategories.keys()])) {
            const before = priorCategories.get(id);
            const after = currentCategories.get(id);
            if (before === undefined)
                categoryDelta[id] = "new";
            else if (after === undefined)
                categoryDelta[id] = "removed";
            else {
                categoryDelta[id] = after - before;
                if (after === before)
                    sameSizedCategoryTokens += after;
            }
        }
    }
    const continuity = stats.startedWithCheckpoint
        ? prior ? "warm" : "checkpoint-without-token-details"
        : "cold";
    const contextDelta = current && prior ? current.usedTokens - prior.usedTokens : undefined;
    const toolsDelta = categoryDelta.tools;
    // When our RequestContext tools overlay bytes are unchanged but Cursor's
    // tools category still moves, the churn is upstream accounting (e.g. plan
    // mode / CreatePlan internals), not a client prefix rebuild.
    const toolsCategoryChurn = stats.requestContextReused
        && typeof toolsDelta === "number"
        && toolsDelta !== 0
        ? "upstream-stable-overlay"
        : !stats.requestContextReused
            && typeof toolsDelta === "number"
            && toolsDelta !== 0
            ? "client-overlay-changed"
            : "none";
    // Occupancy measures context size, not cache reuse. A zero counter on an
    // interaction turn cannot distinguish omitted accounting from a cache miss.
    const interactionZeroRead = stats.startedWithCheckpoint
        && rawRead === 0
        && typeof prior?.usedTokens === "number"
        && prior.usedTokens > 0
        && (stats.createPlanInTurn === true || stats.switchModeInTurn === true);
    return [
        "cache diagnosis:",
        `sessionKey=${stats.sessionKey ?? "-"}`,
        `conversationId=${stats.conversationId}`,
        `conversationGroupId=${stats.conversationGroupId ?? "-"}`,
        `model=${stats.modelId ?? "-"}`,
        `continuity=${continuity}`,
        `coldReason=${continuity === "cold" ? stats.coldReason ?? "unknown" : "-"}`,
        `rawInput=${rawInput}`,
        `rawCacheRead=${rawRead}`,
        `rawCacheWrite=${rawWrite}`,
        `rawUncached=${rawUncached}`,
        `rawReadRatio=${usageRatio(rawRead, rawInput)}`,
        `rawWriteRatio=${usageRatio(rawWrite, rawInput)}`,
        `priorContext=${prior?.usedTokens ?? "unavailable"}`,
        `currentContext=${current?.usedTokens ?? "unavailable"}`,
        `contextDelta=${contextDelta ?? "unavailable"}`,
        // Several model calls in one Run each re-read the prefix, so this multiple
        // routinely exceeds 1 and is not a percentage.
        `rawReadVsPriorContext=${prior && prior.usedTokens > 0 ? `${(rawRead / prior.usedTokens).toFixed(2)}x` : "n/a"}`,
        `sameSizedCategoryTokens=${categoriesComparable ? sameSizedCategoryTokens : "unavailable"}`,
        `categoryDelta=${categoriesComparable && Object.keys(categoryDelta).length > 0 ? JSON.stringify(categoryDelta) : "unavailable"}`,
        `toolsCategoryChurn=${toolsCategoryChurn}`,
        `requestContext=${stats.requestContextReused ? "reused" : "built"}`,
        `requestContextHash=${stats.requestContextHash.slice(0, 16)}`,
        `systemPromptHash=${stats.systemPromptHash?.slice(0, 16) ?? "none"}`,
        `systemPromptSent=${!stats.startedWithCheckpoint}`,
        `checkpointUpdates=${stats.checkpointUpdates}`,
        `tokenDetailUpdates=${stats.tokenDetailUpdates}`,
        `pumpPasses=${stats.pumpPasses}`,
        `steps=${stats.stepStarts}/${stats.stepCompletes}`,
        `displayToolCalls=${stats.displayToolCalls}`,
        `execRequests=${stats.execRequests}`,
        `createPlanInTurn=${stats.createPlanInTurn === true}`,
        `switchModeInTurn=${stats.switchModeInTurn === true}`,
        ...(interactionZeroRead
            ? [
                "turnEndedCacheRead=zero-interaction",
                "cacheReuseEvidence=unavailable",
            ]
            : []),
        "perModelCallCache=unavailable",
    ].join(" ");
}
/**
 * One-line proof that Cursor, AI SDK, and projected OpenCode totals agree.
 * `counterKind` names what `counters` hold so the line labels them truthfully:
 * Cursor's TurnEnded request counters (`raw*`) or the occupancy-shaped counters
 * of {@link occupancyValidationCounters} (`occupancy*`).
 */
export function formatTurnUsageValidation(counters, usage, tokenDetails, contextSource, counterKind = "turn-ended") {
    const counterLabel = counterKind === "occupancy" ? "occupancy" : "raw";
    const input = usageCount(usage.inputTokens.total);
    const noCache = usageCount(usage.inputTokens.noCache);
    const cacheRead = usageCount(usage.inputTokens.cacheRead);
    const cacheWrite = usageCount(usage.inputTokens.cacheWrite);
    const inputParts = noCache + cacheRead + cacheWrite;
    const output = usageCount(usage.outputTokens.total);
    const text = usageCount(usage.outputTokens.text);
    const reasoning = usageCount(usage.outputTokens.reasoning);
    const outputParts = text + reasoning;
    const sentTotal = input + output;
    const projectedOpenCodeTotal = inputParts + outputParts;
    const rawTotal = counters.inputTokens + counters.outputTokens;
    const cursor = tokenDetails
        ? `${tokenDetails.usedTokens}/${tokenDetails.maxTokens}` +
            `(${usageRatio(tokenDetails.usedTokens, tokenDetails.maxTokens)})`
        : "unavailable";
    const totalMatch = tokenDetails ? String(sentTotal === tokenDetails.usedTokens) : "unavailable";
    const breakdown = tokenDetails?.breakdown;
    const categorySum = breakdown?.categories.reduce((sum, category) => sum + category.estimatedTokens, 0);
    const breakdownMatch = breakdown && categorySum !== undefined
        ? categorySum !== breakdown.totalUsedTokens
            ? false
            : currentCursorTokenBreakdown(tokenDetails) ? true : "stale"
        : undefined;
    const rawCached = counters.cacheRead + counters.cacheWrite;
    const sentCached = cacheRead + cacheWrite;
    const proportionalCached = counters.inputTokens > 0 && input > 0
        ? Math.round(input * rawCached / counters.inputTokens)
        : 0;
    const cacheRatioMatch = tokenDetails
        ? counters.inputTokens > 0 && input > 0
            ? Math.abs(rawCached / counters.inputTokens - sentCached / input) <= 1 / input
                || (sentCached >= proportionalCached && sentCached <= input)
            : rawCached === 0 && sentCached === 0
        : undefined;
    const status = input === inputParts &&
        output === outputParts &&
        projectedOpenCodeTotal === sentTotal &&
        (counterKind !== "occupancy" || rawTotal === sentTotal) &&
        (cacheRatioMatch ?? true) &&
        (!tokenDetails || sentTotal === tokenDetails.usedTokens) &&
        breakdownMatch !== false
        ? "ok"
        : "mismatch";
    return [
        "turn usage validation:",
        `status=${status}`,
        `source=${tokenDetails ? contextSource ?? "checkpoint-current-run" : "unavailable"}`,
        `cursor=${cursor}`,
        `${counterLabel}Total=${rawTotal}`,
        `sentTotal=${sentTotal}`,
        `totalMatch=${totalMatch}`,
        `input=${input}`,
        `inputParts=${inputParts}`,
        `inputMatch=${input === inputParts}`,
        `output=${output}`,
        `outputParts=${outputParts}`,
        `outputMatch=${output === outputParts}`,
        `opencodeProjectedTotal=${projectedOpenCodeTotal}`,
        `opencodeMatch=${projectedOpenCodeTotal === sentTotal}`,
        `breakdownTotal=${breakdown?.totalUsedTokens ?? "unavailable"}`,
        `categorySum=${categorySum ?? "unavailable"}`,
        `breakdownMatch=${breakdownMatch ?? "unavailable"}`,
        `${counterLabel}CachedRatio=${usageRatio(rawCached, counters.inputTokens)}`,
        `sentCachedRatio=${usageRatio(sentCached, input)}`,
        `cacheRatioMatch=${cacheRatioMatch ?? "unavailable"}`,
    ].join(" ");
}
/**
 * The `finish:` trace. `v3*` is the usage sent to OpenCode. The second group is
 * labelled by where its numbers come from: `raw*` are Cursor's TurnEnded
 * request counters (whole Run), `occupancy*` the checkpoint snapshot a
 * tool-call boundary sends (its cache split as billed: the previous step's
 * context, see `src/billing.ts`), and
 * `est*` the provider's char/4 estimate before any checkpoint arrived.
 */
export function formatFinishTrace(input) {
    const { usage, turnEnded, occupancy, estimate } = input;
    const counters = turnEnded
        ? `rawIn=${turnEnded.inputTokens} rawOut=${turnEnded.outputTokens} ` +
            `rawCacheRead=${turnEnded.cacheRead} rawCacheWrite=${turnEnded.cacheWrite} ` +
            (occupancy ? `occupancyPrefixCache=${occupancy.priorUsedTokens} ` : "")
        : occupancy
            ? `occupancyIn=${Math.max(0, occupancy.usedTokens - 1)} occupancyOut=${occupancy.usedTokens > 0 ? 1 : 0} ` +
                `occupancyCacheRead=${usage.inputTokens?.cacheRead ?? 0} ` +
                `occupancyCacheWrite=${usage.inputTokens?.cacheWrite ?? 0} `
            : `estIn=${estimate.inputTokens} estOut=${estimate.outputTokens} ` +
                `estCacheRead=${estimate.cacheRead} estCacheWrite=${estimate.cacheWrite} `;
    return `finish: reason=${input.reason} ` +
        `v3In=${usage.inputTokens?.total ?? 0} v3Out=${usage.outputTokens?.total ?? 0} ` +
        `v3CacheRead=${usage.inputTokens?.cacheRead ?? 0} v3CacheWrite=${usage.inputTokens?.cacheWrite ?? 0} ` +
        `v3Reasoning=${usage.outputTokens?.reasoning ?? 0} ` +
        counters +
        `source=${input.source}`;
}
/**
 * A warning when Cursor's checkpoint counts no rules although this Run sent the
 * system-instructions rule: the host system context (AGENTS.md, skills,
 * subagents) is then likely absent from the model's prompt. Undefined when the
 * breakdown is missing or stale, or when rules were counted.
 */
export function missingRulesWarning(details, sentRuleChars, conversationId) {
    if (sentRuleChars <= 0)
        return undefined;
    const rules = currentCursorTokenBreakdown(details)?.categories.find((category) => category.id === "rules");
    if (!rules || rules.estimatedTokens > 0)
        return undefined;
    return `context warning: Cursor counted rules=0 although this Run sent the ${sentRuleChars}-char ` +
        `system-instructions rule conversationId=${conversationId} — host instructions may not reach the model`;
}
/** OpenCode requires a usage object at every step boundary. */
export function emptyLanguageModelV3Usage() {
    return buildLanguageModelV3UsageFromCounters({
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
    });
}
/**
 * Occupancy-shaped counters for {@link formatTurnUsageValidation}: `usedTokens`
 * with `prior.usedTokens` of it cached, the shape every step finish sends
 * (`shapeStepUsage` in `src/billing.ts`). Always validate occupancy finishes —
 * including TurnEnded/stop — against these, not against aggregate TurnEnded
 * request counters. Request cache ratios stay on `finish:` / cache diagnosis.
 */
export function occupancyValidationCounters(details, prior) {
    const used = Math.max(0, Math.trunc(details.usedTokens));
    const input = Math.max(0, used - 1);
    return {
        inputTokens: input,
        outputTokens: used > 0 ? 1 : 0,
        // Cursor can shrink the context between checkpoints; the prior prefix
        // cannot be larger than what is in context now.
        cacheRead: Math.min(input, Math.max(0, Math.trunc(prior?.usedTokens ?? 0))),
        cacheWrite: 0,
        reasoningTokens: 0,
    };
}
/** Project nested V3 usage into the common flat AI-SDK counter shape. */
export function flatUsageFromV3(usage) {
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    const noCache = input.noCache ?? 0;
    const cacheRead = input.cacheRead ?? 0;
    const cacheWrite = input.cacheWrite ?? 0;
    const reasoning = output.reasoning ?? 0;
    const text = output.text ?? Math.max(0, (output.total ?? 0) - reasoning);
    return {
        inputTokens: noCache,
        outputTokens: text,
        reasoningTokens: reasoning,
        cacheReadInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
    };
}
