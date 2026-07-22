export declare const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * Ensures the request body is replayable before attempting a retry.
 */
export declare function canRetryRequest(init: RequestInit | undefined): boolean;
/**
 * Status code-based retry strategy, consistent with Gemini/Agy CLI.
 */
export declare function isRetryableStatus(status: number): boolean;
/**
 * Handles transient network failures (including error codes nested in `cause.code`).
 */
export declare function isRetryableNetworkError(error: unknown): boolean;
/**
 * Prioritizes parsing retry delay milliseconds via Retry-After header, quota info in response body, or fallback exponential backoff.
 */
export declare function resolveRetryDelayMs(response: Response, attempt: number, quotaDelayMs?: number): Promise<number>;
export declare function getExponentialDelayWithJitter(attempt: number): number;
export declare function wait(ms: number): Promise<void>;
