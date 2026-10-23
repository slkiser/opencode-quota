/**
 * Bound a complete async operation, not only fetch(). Response body readers can
 * ignore abort signals, so Promise.race remains the authoritative deadline.
 *
 * Rejects with `timeoutError()` before aborting so callers observe the domain
 * timeout error rather than a generic AbortError.
 */
export declare function withAbortDeadline<T>(timeoutMs: number, timeoutError: () => Error, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
