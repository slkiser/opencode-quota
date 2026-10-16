/** Structured provider failure with retry and transport diagnostics. */
export class CursorProviderError extends Error {
    origin;
    transient;
    replaySafe;
    /**
     * The Run failed because Cursor could not restore the resumed checkpoint
     * (it requested blobs this client does not hold) before producing anything.
     * Recovery must reseed a new conversation instead of resuming that checkpoint.
     */
    checkpointUnusable;
    statusCode;
    grpcStatus;
    rstCode;
    code;
    retryAfterMs;
    constructor(message, options) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "CursorProviderError";
        this.origin = options.origin;
        this.transient = options.transient;
        this.replaySafe = options.replaySafe;
        this.statusCode = options.statusCode;
        this.grpcStatus = options.grpcStatus;
        this.rstCode = options.rstCode;
        this.code = options.code;
        this.retryAfterMs = options.retryAfterMs;
    }
}
export class CursorLocalCancellationError extends CursorProviderError {
    constructor(message = "Cursor request cancelled locally", cause) {
        super(message, {
            origin: "local-cancel",
            transient: false,
            replaySafe: false,
            cause,
        });
        this.name = "CursorLocalCancellationError";
    }
}
export class CursorTransportError extends CursorProviderError {
    constructor(message, options = {
        transient: true,
        replaySafe: true,
    }) {
        super(message, { ...options, origin: "transport" });
        this.name = "CursorTransportError";
    }
}
export class CursorServerError extends CursorProviderError {
    constructor(message, options) {
        super(message, { ...options, origin: "server" });
        this.name = "CursorServerError";
    }
}
export class CursorProtocolError extends CursorProviderError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            origin: "protocol",
            transient: false,
            replaySafe: false,
        });
        this.name = "CursorProtocolError";
    }
}
export class CursorAuthError extends CursorProviderError {
    constructor(message = "Cursor authentication failed; reauthenticate with Cursor", options = {}) {
        super(message, {
            ...options,
            origin: "auth",
            transient: false,
            replaySafe: options.replaySafe ?? false,
        });
        this.name = "CursorAuthError";
    }
}
function isUnauthenticatedStatus(status) {
    if (status === undefined)
        return false;
    const normalized = String(status).toLowerCase().replaceAll("-", "_");
    return normalized === "16" || normalized === "unauthenticated";
}
/**
 * Cursor refused the request's credential (HTTP 401 / gRPC unauthenticated),
 * as opposed to refusing the account an action (403 / permission_denied).
 * Only this case is worth one renewed-token retry.
 */
export function isRejectedCredentialError(error) {
    return error instanceof CursorAuthError && (error.statusCode === 401 ||
        isUnauthenticatedStatus(error.grpcStatus) ||
        isUnauthenticatedStatus(error.code));
}
/**
 * OpenCode's SessionRetry treats several substrings in provider error messages
 * as always-retryable — notably bare "unavailable" and "exhausted", plus a
 * broader regex set (resource_exhausted, service unavailable, …).
 *
 * When this provider has already spent its Run retry budget, or has decided a
 * replay would be unsafe, the host-facing message must not re-arm that loop.
 * Keep the real gRPC/HTTP code on structured fields (`code`, `grpcStatus`).
 */
export function sanitizeHostTerminalMessage(message) {
    return message
        .replace(/\bresource[_\s-]?exhausted\b/gi, "capacity_limit")
        .replace(/\bservice[_\s-]?unavailable\b/gi, "capacity_limit")
        .replace(/\bunavailable\b/gi, "capacity_limit")
        .replace(/\boverloaded\b/gi, "capacity_limit")
        .replace(/\bretry exhausted\b/gi, "retries finished")
        .replace(/\bexhausted\b/gi, "finished");
}
export class CursorRetryExhaustedError extends CursorProviderError {
    attempts;
    constructor(attempts, last) {
        // Host-facing text must not contain OpenCode SessionRetry trigger words
        // ("unavailable", "exhausted", …). Structured fields keep the real code.
        super(`Cursor Run failed after ${attempts} attempts: ${sanitizeHostTerminalMessage(last.message)}`, {
            origin: last.origin,
            transient: false,
            replaySafe: false,
            statusCode: last.statusCode,
            grpcStatus: last.grpcStatus,
            rstCode: last.rstCode,
            code: last.code,
            retryAfterMs: last.retryAfterMs,
            cause: last,
        });
        this.name = "CursorRetryExhaustedError";
        this.attempts = attempts;
    }
}
const TRANSIENT_NETWORK_CODES = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETRESET",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ERR_HTTP2_GOAWAY_SESSION",
    "ERR_HTTP2_SESSION_ERROR",
    "ERR_HTTP2_STREAM_CANCEL",
    "ERR_HTTP2_STREAM_ERROR",
    "ETIMEDOUT",
]);
export function isTransientGrpcStatus(status) {
    const normalized = String(status).toLowerCase().replaceAll("-", "_");
    return (normalized === "8" ||
        normalized === "13" ||
        normalized === "14" ||
        normalized === "internal" ||
        normalized === "resource_exhausted" ||
        normalized === "unavailable");
}
export function isAuthGrpcStatus(status) {
    const normalized = String(status).toLowerCase().replaceAll("-", "_");
    return (normalized === "7" ||
        normalized === "16" ||
        normalized === "permission_denied" ||
        normalized === "unauthenticated");
}
export function cursorHttpError(operation, statusCode, diagnostics = {}) {
    if (statusCode === 401 || statusCode === 403) {
        // A rejected credential means the server did no work: replaying with a
        // renewed token is safe unless the attempt already crossed a barrier.
        return new CursorAuthError(`Cursor authentication failed (HTTP ${statusCode}); reauthenticate with Cursor`, { ...diagnostics, statusCode, replaySafe: statusCode === 401 });
    }
    return new CursorServerError(`${operation} HTTP ${statusCode}`, {
        ...diagnostics,
        statusCode,
        transient: statusCode === 429 || statusCode >= 500,
        replaySafe: true,
    });
}
export function cursorGrpcError(operation, grpcStatus, diagnostics = {}) {
    if (isAuthGrpcStatus(grpcStatus)) {
        return new CursorAuthError(`Cursor authentication failed (gRPC ${grpcStatus}); reauthenticate with Cursor`, { ...diagnostics, grpcStatus, replaySafe: isUnauthenticatedStatus(grpcStatus) });
    }
    return new CursorServerError(`${operation} gRPC status ${grpcStatus}`, {
        ...diagnostics,
        grpcStatus,
        transient: isTransientGrpcStatus(grpcStatus),
        replaySafe: true,
    });
}
export function errorCode(error) {
    if (!error || typeof error !== "object")
        return undefined;
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
export function toCursorProviderError(error, options = { replaySafe: false }) {
    if (error instanceof CursorProviderError) {
        error.replaySafe = options.replaySafe && error.replaySafe;
        return error;
    }
    const code = errorCode(error);
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : "";
    if (name.startsWith("Auth") || /access token|api key|authentication/i.test(message)) {
        return new CursorAuthError(undefined, { code, cause: error });
    }
    const httpStatus = /\bHTTP\s+(\d{3})\b/i.exec(message)?.[1];
    if (httpStatus) {
        const failure = cursorHttpError("Cursor request failed with", Number(httpStatus), { code });
        failure.replaySafe = options.replaySafe && failure.replaySafe;
        return failure;
    }
    if (code && TRANSIENT_NETWORK_CODES.has(code)) {
        return new CursorTransportError(`Cursor transport failure (${code})`, {
            transient: true,
            replaySafe: options.replaySafe,
            code,
            cause: error,
        });
    }
    if (error instanceof TypeError) {
        return new CursorProtocolError(options.fallback ?? "Invalid Cursor provider configuration", {
            code,
            cause: error,
        });
    }
    return new CursorProtocolError(options.fallback ?? `Cursor provider failure (${name})`, {
        code,
        cause: error,
    });
}
export function retrySuppressedError(cause, reason, attempt, maxAttempts) {
    const subject = sanitizeHostTerminalMessage(cause.message.replace(/^Cursor Run stream /, "Cursor stream "));
    return new CursorProviderError(`${subject} ${reason}; automatic retry unsafe (attempt ${attempt}/${maxAttempts})`, {
        origin: cause.origin,
        transient: false,
        replaySafe: false,
        statusCode: cause.statusCode,
        grpcStatus: cause.grpcStatus,
        rstCode: cause.rstCode,
        code: cause.code,
        retryAfterMs: cause.retryAfterMs,
        cause,
    });
}
