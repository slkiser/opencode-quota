export interface QuotaContext {
    terminal: boolean;
    retryDelayMs?: number;
    reason?: string;
}
/**
 * NOTE: Special Design - Granular 429 Error Classification and Retry Strategy
 * Traditional network retry modules usually treat 429 errors uniformly as rate-limiting for retries or throwing errors.
 * Here we parse it granularly:
 * 1. Differentiate between "Account physical quota exhausted" and "Model instantaneous capacity overloaded (MODEL_CAPACITY_EXHAUSTED)".
 * 2. If it's physical quota exhaustion, it's considered an unretriable terminal state to avoid meaningless network requests;
 *    If it's a momentary overload of Google's backend model capacity, it's considered retriable, parses RetryInfo delay from response, and notifies the upper layer (showing a Toast in TUI, backing off, and retrying).
 */
export declare function classifyQuotaResponse(response: Response): Promise<QuotaContext | null>;
/**
 * Extracts the RetryInfo delay hint directly from the error payload.
 */
export declare function parseRetryDelayFromBody(response: Response): Promise<number | null>;
declare function parseRetryDelayValue(value: string | {
    seconds?: number;
    nanos?: number;
}): number | null;
declare function parseRetryDelayFromMessage(message: string): number | null;
export declare const retryInternals: {
    parseRetryDelayValue: typeof parseRetryDelayValue;
    parseRetryDelayFromMessage: typeof parseRetryDelayFromMessage;
};
export {};
