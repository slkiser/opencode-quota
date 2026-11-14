/** `CURSOR_PROVIDER_DEBUG` as a level: 0 off, 1 (`1`/`true`), 2 (`2`/`verbose`). */
export declare function resolveDebugLevel(value?: string | undefined): 0 | 1 | 2;
export declare const DEBUG_LOG_MAX_BYTES: number;
export declare const DEBUG_LOG_KEEP_BYTES: number;
export declare const DEBUG_LOG_TRIM_INTERVAL_MS: number;
export declare const DEBUG_LOG_TRIM_LOCK_STALE_MS: number;
export declare const DEBUG_LOG_ROTATE_BACKUPS = 5;
export declare function resolveDebugLogOptions(env?: NodeJS.ProcessEnv): {
    mode: "trim" | "rotate";
    maxBytes: number;
    backups: number;
    warnings: string[];
};
/** Message of an unknown thrown value, for log lines and error text. */
export declare function errorMessage(error: unknown): string;
/** Whether `CURSOR_PROVIDER_DEBUG` is enabled for this process. */
export declare function isDebugEnabled(): boolean;
/** Resolve the debug log path (env override or per-uid tmpdir default). */
export declare function resolveDebugLogPath(): string;
/**
 * Ensure the log directory is 0o700 and the log file exists as 0o600.
 * Does **not** truncate an existing file — mid-run re-init must keep prior lines.
 * Returns whether the opened file already held bytes.
 * Exported for tests; callers normally go through `trace`.
 */
export declare function ensureSecureDebugLog(filePath: string, options?: {
    secureParent?: boolean;
}): boolean;
/**
 * Compact an oversized log in place, keeping its recent line-aligned tail.
 * Like OpenCode's logger, lock only trimmers: a concurrent append between the
 * final read and truncate can be lost. Never replace the inode or erase the log
 * as a fallback. Exported for tests; trace schedules maintenance hourly.
 */
export declare function trimDebugLogIfOversized(filePath: string, options?: {
    maxBytes?: number;
    keepBytes?: number;
}): boolean;
/** Numbered archives, newest in .1. Rotation never falls back to truncation. */
export declare function rotateDebugLogIfOversized(filePath: string, options?: {
    maxBytes?: number;
    backups?: number;
}): boolean;
export declare function trace(msg: string): void;
/** `trace` only at `CURSOR_PROVIDER_DEBUG=2`: per-frame wire detail. */
export declare function traceVerbose(msg: string): void;
/**
 * Write `brief` only while the file this line goes to still holds `proof` (part of `full`) near
 * where `key`'s full line was last written, at most 10 minutes ago; otherwise write `full`.
 * Checked through the descriptor the line goes through, before and after it, so a rotation,
 * truncation or replacement by this process or another leads to `full`. Only in rotate mode:
 * a trim drops a file's oldest lines, which can hold the full line of a hash it keeps.
 */
export declare function traceOncePerLog(key: string, full: string, brief: string, proof?: string): void;
/** The tools a request advertised, by name once per log file and by hash after that. */
export declare function traceToolList(incoming: number, advertised: readonly {
    name: string;
}[]): void;
/**
 * Compact path-advertising summary for RequestContext troubleshooting.
 * Safe: no tokens / file contents — only workspace vs metadata roots.
 */
export declare function traceRequestContextPaths(label: string, requestContext: Record<string, unknown> | undefined): void;
