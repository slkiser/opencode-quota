/** Soft cap for the debug log file; exceeded size triggers truncate + new header. */
export declare const DEBUG_LOG_MAX_BYTES: number;
/** Message of an unknown thrown value, for log lines and error text. */
export declare function errorMessage(error: unknown): string;
/** Whether `CURSOR_PROVIDER_DEBUG` is enabled for this process. */
export declare function isDebugEnabled(): boolean;
/** Resolve the debug log path (env override or per-uid tmpdir default). */
export declare function resolveDebugLogPath(): string;
/**
 * Ensure the log directory is 0o700 and the log file exists as 0o600.
 * Does **not** truncate an existing file — mid-run re-init must keep prior lines.
 * Exported for tests; callers normally go through `trace`.
 */
export declare function ensureSecureDebugLog(filePath: string, options?: {
    secureParent?: boolean;
}): void;
/**
 * If `filePath` is at least `maxBytes`, truncate it and write a size-cap header.
 * Returns true when a truncate happened. Exported for tests.
 */
export declare function truncateDebugLogIfOversized(filePath: string, maxBytes?: number): boolean;
export declare function trace(msg: string): void;
/**
 * Compact path-advertising summary for RequestContext troubleshooting.
 * Safe: no tokens / file contents — only workspace vs metadata roots.
 */
export declare function traceRequestContextPaths(label: string, requestContext: Record<string, unknown> | undefined): void;
