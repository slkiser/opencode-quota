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
    constructor(message: string, options: CursorProviderErrorOptions);
}
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
 * OpenCode's SessionRetry treats several substrings in provider error messages
 * as always-retryable — notably bare "unavailable" and "exhausted", plus a
 * broader regex set (resource_exhausted, service unavailable, …).
 *
 * When this provider has already spent its Run retry budget, or has decided a
 * replay would be unsafe, the host-facing message must not re-arm that loop.
 * Keep the real gRPC/HTTP code on structured fields (`code`, `grpcStatus`).
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
export declare function retrySuppressedError(cause: CursorProviderError, reason: string, attempt: number, maxAttempts: number): CursorProviderError;
