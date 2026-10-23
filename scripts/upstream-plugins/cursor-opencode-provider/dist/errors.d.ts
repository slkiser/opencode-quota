export type CursorErrorOrigin = "local-cancel" | "transport" | "server" | "protocol" | "auth";
export type CursorErrorDiagnostics = {
    statusCode?: number;
    grpcStatus?: number | string;
    rstCode?: number;
    code?: string;
    retryAfterMs?: number;
};
export type CursorProviderErrorOptions = CursorErrorDiagnostics & {
    origin: CursorErrorOrigin;
    transient: boolean;
    replaySafe: boolean;
    retryable?: boolean;
    hostRetryable?: boolean;
    cause?: unknown;
};
/** Structured provider failure with retry and transport diagnostics. */
export declare class CursorProviderError extends Error {
    readonly origin: CursorErrorOrigin;
    readonly transient: boolean;
    replaySafe: boolean;
    /**
     * The Run failed because Cursor could not restore the resumed checkpoint
     * (it requested blobs this client does not hold) before producing anything.
     * Recovery must reseed a new conversation instead of resuming that checkpoint.
     */
    checkpointUnusable?: boolean;
    readonly statusCode?: number;
    readonly grpcStatus?: number | string;
    readonly rstCode?: number;
    readonly code?: string;
    readonly retryAfterMs?: number;
    /** Cursor's classified verdict, or false once provider retries must stop. */
    readonly retryable?: boolean;
    /**
     * The provider stopped, but the host may send the turn again: the failed
     * attempt only showed text or reasoning, before any checkpoint. Cursor CLI
     * resends the same action in this case.
     */
    readonly hostRetryable?: boolean;
    /** What the failed attempt did that a replay inside the Run would repeat. */
    replayBarrier?: "output-only" | "stateful";
    constructor(message: string, options: CursorProviderErrorOptions);
}
/**
 * The error the host receives. Like Cursor CLI, a request Cursor declared not
 * retryable (see `cursorCliRetryable`), a spent/unsafe provider retry, or an
 * authentication failure ends the turn: it becomes an AI SDK `APICallError`
 * with `isRetryable: false` and the
 * conventional `x-should-retry: false` header, which OpenCode 2 checks first
 * (it retries a failure with no status or recognized code). OpenCode 1.x
 * ignores both and retries any status >= 500 or a message matching its retry
 * patterns, so the status is the Connect code's HTTP status capped below 500
 * (Cursor CLI decides from the verdict, never the code) and the message is
 * sanitized. The original code stays on `cause`.
 *
 * A `hostRetryable` failure is the opposite: Cursor CLI would send the same
 * action again, but output the host already shows stops the provider from
 * doing so. It becomes an `APICallError` with `isRetryable: true`, which
 * OpenCode 1.x retries as the same step, and `x-should-retry: true` without a
 * status, which OpenCode 2 continues after the shown output.
 */
export declare function hostFacingError(error: unknown): Error;
export declare class CursorLocalCancellationError extends CursorProviderError {
    constructor(message?: string, cause?: unknown);
}
export declare class CursorTransportError extends CursorProviderError {
    constructor(message: string, options?: Omit<CursorProviderErrorOptions, "origin">);
}
export declare class CursorServerError extends CursorProviderError {
    constructor(message: string, options: Omit<CursorProviderErrorOptions, "origin">);
}
export declare class CursorProtocolError extends CursorProviderError {
    constructor(message: string, options?: Partial<CursorErrorDiagnostics> & {
        cause?: unknown;
    });
}
export declare class CursorAuthError extends CursorProviderError {
    constructor(message?: string, options?: Partial<CursorErrorDiagnostics> & {
        cause?: unknown;
        replaySafe?: boolean;
    });
}
/**
 * Cursor refused the request's credential (HTTP 401 / gRPC unauthenticated),
 * as opposed to refusing the account an action (403 / permission_denied).
 * Only this case is worth one renewed-token retry.
 */
export declare function isRejectedCredentialError(error: unknown): error is CursorAuthError;
/**
 * When this provider has already spent its Run retry budget, decided a replay
 * would be unsafe, or Cursor declared the request not retryable, the
 * host-facing message must not re-arm OpenCode's SessionRetry loop. Common
 * trigger words get readable replacements; any remaining match (status-like
 * digits, Cursor's own wording) is split with a word joiner. Keep the real
 * gRPC/HTTP code on structured fields (`code`, `grpcStatus`).
 */
export declare function sanitizeHostTerminalMessage(message: string): string;
export declare class CursorRetryExhaustedError extends CursorProviderError {
    readonly attempts: number;
    constructor(attempts: number, last: CursorProviderError);
}
export declare function isTransientGrpcStatus(status: number | string): boolean;
export declare function isAuthGrpcStatus(status: number | string): boolean;
export declare function cursorHttpError(operation: string, statusCode: number, diagnostics?: Omit<CursorErrorDiagnostics, "statusCode">): CursorProviderError;
export declare function cursorGrpcError(operation: string, grpcStatus: number | string, diagnostics?: Omit<CursorErrorDiagnostics, "grpcStatus">): CursorProviderError;
export declare function errorCode(error: unknown): string | undefined;
export declare function toCursorProviderError(error: unknown, options?: {
    replaySafe: boolean;
    fallback?: string;
}): CursorProviderError;
/**
 * A transient failure after the attempt showed only text or reasoning, before
 * any checkpoint of the turn. Cursor CLI sends the same action again; the host
 * does that here (see `hostFacingError`), and the lost-request record carries
 * the user's request once.
 */
export declare function hostRetryError(cause: CursorProviderError, beforeOutput?: boolean): CursorProviderError;
/**
 * Cursor CLI stops automatic resumes after two resumed attempts that streamed
 * but saved no checkpoint, so the turn does not repeat the same work forever.
 */
export declare function noProgressResumeError(cause: CursorProviderError, resumes: number): CursorProviderError;
export declare function retrySuppressedError(cause: CursorProviderError, reason: string, attempt: number, maxAttempts: number): CursorProviderError;
