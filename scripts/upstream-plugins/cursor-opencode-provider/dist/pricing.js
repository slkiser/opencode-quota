/**
 * Cursor model token pricing for OpenCode cost reporting.
 *
 * Rates come from Cursor's public docs (Cursor Models + Other Models tables).
 * Generated data lives in `pricing-data.ts`; regenerate with
 * `bun run generate:pricing`. Unknown / unpublished models get no `cost`.
 */
import { CURSOR_MODEL_COSTS } from "./pricing-data.js";
/**
 * Models we expose that Cursor does not currently publish numeric rates for
 * (Auto is billed at the routed model's list price).
 */
export const CURSOR_UNPRICED_MODEL_IDS = ["default"];
const UNPRICED = new Set(CURSOR_UNPRICED_MODEL_IDS);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonNegativeFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function collectCostValidationErrors(value, path, errors) {
    if (!isRecord(value)) {
        errors.push(`${path} must be an object`);
        return;
    }
    if (!isNonNegativeFiniteNumber(value.input)) {
        errors.push(`${path}.input must be a non-negative finite number`);
    }
    if (!isNonNegativeFiniteNumber(value.output)) {
        errors.push(`${path}.output must be a non-negative finite number`);
    }
    if (value.cache_read !== undefined && !isNonNegativeFiniteNumber(value.cache_read)) {
        errors.push(`${path}.cache_read must be a non-negative finite number`);
    }
    if (value.cache_write !== undefined && !isNonNegativeFiniteNumber(value.cache_write)) {
        errors.push(`${path}.cache_write must be a non-negative finite number`);
    }
    if (value.context_over_200k !== undefined) {
        collectCostValidationErrors(value.context_over_200k, `${path}.context_over_200k`, errors);
    }
}
export function validateOpenCodeModelCost(value, path = "cost") {
    const errors = [];
    collectCostValidationErrors(value, path, errors);
    return { valid: errors.length === 0, errors };
}
export function isOpenCodeModelCost(value) {
    return validateOpenCodeModelCost(value).valid;
}
/** Strip synthetic OpenCode suffixes (`…-1m`, `…-1m-2`, `…-1m-fast`, …). */
export function wireModelIdForPricing(modelId) {
    const match = /^(.*)-1m(?:-\d+)?(-fast)?$/.exec(modelId);
    if (match) {
        return { baseId: `${match[1]}${match[2] ?? ""}`, longContextEntry: true };
    }
    return { baseId: modelId, longContextEntry: false };
}
/**
 * True when Cursor publishes a distinct Fast rate for this wire model id.
 * Catalog code uses this to split Fast variants into a `-fast` entry.
 */
export function hasCursorFastPricing(modelId) {
    return Object.prototype.hasOwnProperty.call(CURSOR_MODEL_COSTS, `${modelId}-fast`);
}
function asMutableCost(value) {
    const copy = { input: value.input, output: value.output };
    if (value.cache_read !== undefined)
        copy.cache_read = value.cache_read;
    if (value.cache_write !== undefined)
        copy.cache_write = value.cache_write;
    if (value.context_over_200k) {
        copy.context_over_200k = asMutableCost(value.context_over_200k);
    }
    return copy;
}
/**
 * Look up classic OpenCode cost for a catalog / wire model id.
 * Synthetic `-1m` entries retain both base and documented long-context rates.
 * Synthetic `-fast` entries are stored as their own keys.
 */
export function getCursorModelCost(modelId) {
    const { baseId } = wireModelIdForPricing(modelId);
    const found = CURSOR_MODEL_COSTS[baseId];
    if (!found)
        return undefined;
    return asMutableCost(found);
}
export function applyCursorModelCost(modelId, entry) {
    const modelCost = getCursorModelCost(modelId);
    if (!modelCost)
        return entry;
    return { ...entry, cost: modelCost };
}
/** Convert classic cost → OpenCode 2.0 `Model.Info.cost` array. */
export function toOpenCode2Costs(cost) {
    if (!cost)
        return [];
    const out = [
        {
            input: cost.input,
            output: cost.output,
            cache: {
                read: cost.cache_read ?? 0,
                write: cost.cache_write ?? 0,
            },
        },
    ];
    if (cost.context_over_200k) {
        out.push({
            tier: { type: "context", size: 200_000 },
            input: cost.context_over_200k.input,
            output: cost.context_over_200k.output,
            cache: {
                read: cost.context_over_200k.cache_read ?? 0,
                write: cost.context_over_200k.cache_write ?? 0,
            },
        });
    }
    return out;
}
/**
 * Coverage helper for CI / maintainer checks.
 * Intentionally unpriced first-party ids are counted as priced (covered).
 */
export function checkCursorPricingCoverage(modelIds) {
    const priced = [];
    const missing = [];
    for (const modelId of modelIds) {
        const { baseId } = wireModelIdForPricing(modelId);
        if (UNPRICED.has(baseId) || getCursorModelCost(modelId))
            priced.push(modelId);
        else
            missing.push(modelId);
    }
    return { priced, missing };
}
