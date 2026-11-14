/**
 * What OpenCode is told a Cursor turn costs at catalog rates.
 *
 * OpenCode prices every step finish and adds it to the session: OpenCode 1.x
 * from `providerMetadata.copilot.totalNanoAiu` when present
 * (`session/session.ts` getUsage), OpenCode 2 always from the step's tokens at
 * the model's catalog rates. Each step's token total must also stay equal to
 * Cursor's context occupancy, because both hosts show context use and decide
 * compaction from the latest step's tokens. Cursor reports token counters only
 * once, in `TurnEnded`, aggregated over every model call of its Run.
 *
 * So each tool step is billed an estimate shaped like one model call (the
 * context carried over from the previous step read from cache, the output it
 * streamed as output, the rest new input), and the turn's last step settles the
 * difference to its catalog-priced cost: its input/cache split is chosen so the
 * token-priced cost approaches the outstanding amount, and the same amount goes
 * into `totalNanoAiu`. Both hosts then bill identical amounts at the unmodified
 * catalog rates. What a final step cannot carry stays outstanding for a later
 * priced turn-end. Settlement is bounded by minimum and maximum token prices
 * and whole-token rounding; negative balances cannot refund prior host charges.
 *
 * Output tokens follow the same ledger: a tool step reports a char/4 estimate
 * of what it streamed, and the turn's last step reports Cursor's `output_tokens`
 * (and `reasoning_tokens`) minus that Run's estimates. Already delivered
 * estimates cannot be retracted; an overestimate never reduces a later Run's
 * output. The host's one-token display minimum can also exceed the remainder.
 */
import type { LanguageModelV3Usage } from "@ai-sdk/provider";
import { type OpenCodeModelCost } from "./pricing.js";
import { type CursorUsageCounters } from "./usage.js";
/** USD per token for each category a host prices. */
export type StepPrices = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
/**
 * Price entry the catalog gave this model: `<wire>-fast` for a Fast variant
 * with its own published rate, else the wire id (a long-context entry is
 * priced from the base entry and its over-200k tier), as `model-config.ts` does.
 */
export declare function cursorPricingId(wireModelId: string, parameterValues: ReadonlyArray<{
    id: string;
    value: string;
}>): string;
/** The rates a host applies to a step with `inputSideTokens` of prompt (its context tier). */
export declare function hostStepPrices(cost: OpenCodeModelCost | undefined, inputSideTokens: number): StepPrices | undefined;
/** What a host charges for `usage` at `prices`. */
export declare function hostUsageCostUsd(prices: StepPrices, usage: LanguageModelV3Usage): number;
/**
 * Catalog-priced Run cost from aggregate `TurnEnded` counters. The final
 * context less the Run's output approximates the prompt tier, as hosts choose
 * it for the settling step, bounded by total input. Per-call tiers are unavailable: a Run crossing
 * tiers or compacting internally cannot be priced exactly from these totals.
 * A cache category without its own published rate is priced as input.
 */
export declare function turnEndedCostUsd(cost: OpenCodeModelCost | undefined, counters: CursorUsageCounters, contextTokens: number): number | undefined;
/**
 * Occupancy-shaped usage for one step: `usedTokens` in total, `outputTokens` of
 * it output (at least 1, at most the occupancy), `prefixTokens` of the rest read
 * from cache and the remainder new input. With `targetUsd`, the input split
 * moves between input and cache read (and cache write only when those two
 * cannot reach it) so the host-priced cost meets the target as closely as the
 * total allows.
 */
export declare function shapeStepUsage(input: {
    usedTokens: number;
    prefixTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    prices: StepPrices | undefined;
    targetUsd?: number;
}): {
    usage: LanguageModelV3Usage;
    costUsd: number;
};
/**
 * The most output a step of `usedTokens` can report while {@link shapeStepUsage}
 * can still keep its cost at `targetUsd`: the rest of the step at the cheapest
 * input category, the output at the output rate.
 */
export declare function maxOutputWithinUsd(usedTokens: number, prices: StepPrices, targetUsd: number): number;
/** `providerMetadata.copilot.totalNanoAiu` for a step that costs `usd`. */
export declare function nanoAiuForUsd(usd: number): number;
/** Estimates belong to one Run and are replaced only by that Run's counters. */
export type RunCostEstimate = {
    estimatedUsd?: number;
    estimatedOutputTokens?: number;
    estimatedReasoningTokens?: number;
    ledgerEpoch?: object;
};
/** Output tokens, `reasoning` a subset of `output` as in Cursor's `TurnEnded`. */
export type OutputTokens = {
    output: number;
    reasoning: number;
};
type LedgerTotals = {
    realUsd: number;
    billedUsd: number;
};
type LedgerEntry = LedgerTotals & {
    estimatedUsd: number;
    realOutput: OutputTokens;
    reportedOutput: OutputTokens;
    pendingOutput: OutputTokens;
};
/**
 * Per OpenCode session: catalog-priced cost and output tokens (from
 * `TurnEnded`) and what this provider has reported to the host. Turn-ends
 * reconcile the balances.
 */
export declare class BillingLedger {
    private readonly entries;
    constructor(entries?: Map<string, LedgerEntry>);
    private entry;
    /** A Run's `TurnEnded`: its cost (0 when unpriced) and output replace its estimates. */
    recordReal(key: string, usd: number, run?: RunCostEstimate, output?: OutputTokens): void;
    /** A step delivered to the host; with `run`, its amounts are that Run's estimates. */
    recordBilled(key: string, usd: number, run?: RunCostEstimate, output?: OutputTokens): void;
    /** Confirmed plus unconfirmed cost minus the amount reported to the host. */
    outstanding(key: string): number;
    /**
     * Measured output not yet reported to the host, after reconciling each Run's
     * own estimates. Surplus estimates and display tokens create no future debt.
     */
    outstandingOutput(key: string): OutputTokens;
    outputTotals(key: string): {
        real: OutputTokens;
        reported: OutputTokens;
    };
    estimated(key: string): number;
    totals(key: string): LedgerTotals;
    clear(): void;
}
export declare const billingLedger: BillingLedger;
/** The catalog cost entry for this Run's model, if Cursor publishes one. */
export declare function cursorRunCost(wireModelId: string, parameterValues: ReadonlyArray<{
    id: string;
    value: string;
}>): OpenCodeModelCost | undefined;
export {};
