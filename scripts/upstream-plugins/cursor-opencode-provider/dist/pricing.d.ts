/**
 * Cursor model token pricing for OpenCode cost reporting.
 *
 * Rates come from Cursor's public docs (Cursor Models + Other Models tables).
 * Generated data lives in `pricing-data.ts`; regenerate with
 * `bun run generate:pricing`. Unknown / unpublished models get no `cost`.
 */
/** Classic OpenCode / models.dev cost shape used in provider config. */
export type OpenCodeModelCost = {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    context_over_200k?: OpenCodeModelCost;
};
/** OpenCode 2.0 `Model.Info.cost` entry (array of tiered rates). */
export type OpenCode2ModelCost = {
    tier?: {
        type: "context";
        size: number;
    };
    input: number;
    output: number;
    cache: {
        read: number;
        write: number;
    };
};
export type CursorPricingCoverage = {
    priced: string[];
    missing: string[];
};
/**
 * Models we expose that Cursor does not currently publish numeric rates for
 * (Auto is billed at the routed model's list price).
 */
export declare const CURSOR_UNPRICED_MODEL_IDS: readonly ["default"];
export declare function validateOpenCodeModelCost(value: unknown, path?: string): {
    valid: boolean;
    errors: string[];
};
export declare function isOpenCodeModelCost(value: unknown): value is OpenCodeModelCost;
/** Strip synthetic OpenCode suffixes (`…-1m`, `…-1m-2`, `…-1m-fast`, …). */
export declare function wireModelIdForPricing(modelId: string): {
    baseId: string;
    longContextEntry: boolean;
};
/**
 * True when Cursor publishes a distinct Fast rate for this wire model id.
 * Catalog code uses this to split Fast variants into a `-fast` entry.
 */
export declare function hasCursorFastPricing(modelId: string): boolean;
/**
 * Look up classic OpenCode cost for a catalog / wire model id.
 * Synthetic `-1m` entries retain both base and documented long-context rates.
 * Synthetic `-fast` entries are stored as their own keys.
 */
export declare function getCursorModelCost(modelId: string): OpenCodeModelCost | undefined;
export declare function applyCursorModelCost<T extends Record<string, unknown>>(modelId: string, entry: T): T & {
    cost?: OpenCodeModelCost;
};
/** Convert classic cost → OpenCode 2.0 `Model.Info.cost` array. */
export declare function toOpenCode2Costs(cost: OpenCodeModelCost | undefined): OpenCode2ModelCost[];
/**
 * Coverage helper for CI / maintainer checks.
 * Intentionally unpriced first-party ids are counted as priced (covered).
 */
export declare function checkCursorPricingCoverage(modelIds: string[]): CursorPricingCoverage;
