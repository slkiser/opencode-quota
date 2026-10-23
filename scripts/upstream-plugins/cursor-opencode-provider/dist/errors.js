import { APICallError } from "@ai-sdk/provider";
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
    /** Cursor's classified verdict, or false once provider retries must stop. */
    retryable;
    /**
     * The provider stopped, but the host may send the turn again: the failed
     * attempt only showed text or reasoning, before any checkpoint. Cursor CLI
     * resends the same action in this case.
     */
    hostRetryable;
    /** What the failed attempt did that a replay inside the Run would repeat. */
    replayBarrier;
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
        this.retryable = options.retryable;
        this.hostRetryable = options.hostRetryable;
    }
}
/** Connect error code → HTTP status, per https://connectrpc.com/docs/protocol/#error-codes. */
const CONNECT_CODE_HTTP_STATUS = {
    canceled: 499,
    unknown: 500,
    invalid_argument: 400,
    deadline_exceeded: 504,
    not_found: 404,
    already_exists: 409,
    permission_denied: 403,
    resource_exhausted: 429,
    failed_precondition: 400,
    aborted: 409,
    out_of_range: 400,
    unimplemented: 501,
    internal: 500,
    unavailable: 503,
    data_loss: 500,
    unauthenticated: 401,
};
/** Status for a final failure whose Connect code maps to 5xx (internal, unknown, …). */
const NON_RETRYABLE_SERVER_STATUS = 400;
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
export function hostFacingError(error) {
    if (!(error instanceof Error))
        return new Error(String(error));
    const auth = error instanceof CursorAuthError;
    if (!auth && error instanceof CursorProviderError && error.hostRetryable) {
        return new APICallError({
            message: error.message,
            url: "cursor://agent.v1.AgentService/Run",
            requestBodyValues: {},
            responseHeaders: {
                "x-should-retry": "true",
                ...(error.retryAfterMs === undefined ? {} : { "retry-after-ms": String(error.retryAfterMs) }),
            },
            isRetryable: true,
            cause: error,
        });
    }
    if (!auth && (!(error instanceof CursorProviderError) || error.retryable !== false))
        return error;
    const connectStatus = error.code !== undefined && Object.hasOwn(CONNECT_CODE_HTTP_STATUS, error.code)
        ? CONNECT_CODE_HTTP_STATUS[error.code]
        : CONNECT_CODE_HTTP_STATUS.unknown;
    const status = auth ? (error.statusCode === 403 ? 403 : 401) : connectStatus;
    return new APICallError({
        message: sanitizeHostTerminalMessage(error.message),
        url: "cursor://agent.v1.AgentService/Run",
        requestBodyValues: {},
        statusCode: status >= 500 ? NON_RETRYABLE_SERVER_STATUS : status,
        responseHeaders: { "x-should-retry": "false" },
        isRetryable: false,
        cause: error,
    });
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
 * OpenCode 1.x SessionRetry retries an error whose message matches these
 * patterns even when it is marked non-retryable (`RETRYABLE_MESSAGE_PATTERNS`
 * and the `exhausted` / `unavailable` / `too_many_requests` substrings in
 * upstream `packages/opencode/src/session/retry.ts`, v1.19). The status
 * patterns match anywhere, so "$1500" or "500k" also re-arm it.
 */
const HOST_RETRY_MESSAGE_PATTERNS = [
    /429|500|502|503|504|524/gi,
    /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests|too_many_requests/gi,
    /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/gi,
    /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/gi,
    /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/gi,
    /try your request again|retry your request|resource exhausted|resource_exhausted/gi,
    /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/gi,
    /exhausted|unavailable/gi,
];
/** Invisible U+2060 WORD JOINER: the text reads the same but no longer matches. */
const WORD_JOINER = "\u2060";
/**
 * When this provider has already spent its Run retry budget, decided a replay
 * would be unsafe, or Cursor declared the request not retryable, the
 * host-facing message must not re-arm OpenCode's SessionRetry loop. Common
 * trigger words get readable replacements; any remaining match (status-like
 * digits, Cursor's own wording) is split with a word joiner. Keep the real
 * gRPC/HTTP code on structured fields (`code`, `grpcStatus`).
 */
export function sanitizeHostTerminalMessage(message) {
    let text = message
        .replace(/\bresource[_\s-]?exhausted\b/gi, "capacity_limit")
        .replace(/\bservice[_\s-]?unavailable\b/gi, "capacity_limit")
        .replace(/\bunavailable\b/gi, "capacity_limit")
        .replace(/\boverloaded\b/gi, "capacity_limit")
        .replace(/\bretry exhausted\b/gi, "retries finished")
        .replace(/\bexhausted\b/gi, "finished");
    // A joiner can add a `\b` boundary, so repeat until nothing matches.
    for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (const pattern of HOST_RETRY_MESSAGE_PATTERNS) {
            text = text.replace(pattern, (match) => {
                changed = true;
                return `${match[0]}${WORD_JOINER}${match.slice(1)}`;
            });
        }
        if (!changed)
            break;
    }
    return text;
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
            retryable: false,
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
/**
 * A transient failure after the attempt showed only text or reasoning, before
 * any checkpoint of the turn. Cursor CLI sends the same action again; the host
 * does that here (see `hostFacingError`), and the lost-request record carries
 * the user's request once.
 */
export function hostRetryError(cause, beforeOutput = false) {
    return new CursorProviderError(beforeOutput
        ? `${cause.message}; the Run could not start and the turn can be sent again`
        : `${cause.message} after visible output, before Cursor saved a checkpoint; the turn can be sent again`, {
        origin: cause.origin,
        transient: false,
        replaySafe: false,
        hostRetryable: true,
        statusCode: cause.statusCode,
        grpcStatus: cause.grpcStatus,
        rstCode: cause.rstCode,
        code: cause.code,
        retryAfterMs: cause.retryAfterMs,
        cause,
    });
}
/**
 * Cursor CLI stops automatic resumes after two resumed attempts that streamed
 * but saved no checkpoint, so the turn does not repeat the same work forever.
 */
export function noProgressResumeError(cause, resumes) {
    return new CursorProviderError(`Cursor Run stopped after ${resumes} resume attempts made no progress; ` +
        "send a message to continue from the last saved state", {
        origin: cause.origin,
        transient: false,
        replaySafe: false,
        retryable: false,
        code: cause.code,
        cause,
    });
}
export function retrySuppressedError(cause, reason, attempt, maxAttempts) {
    const subject = sanitizeHostTerminalMessage(cause.message.replace(/^Cursor Run stream /, "Cursor stream "));
    return new CursorProviderError(`${subject} ${reason}; automatic retry unsafe (attempt ${attempt}/${maxAttempts})`, {
        origin: cause.origin,
        transient: false,
        replaySafe: false,
        retryable: false,
        statusCode: cause.statusCode,
        grpcStatus: cause.grpcStatus,
        rstCode: cause.rstCode,
        code: cause.code,
        retryAfterMs: cause.retryAfterMs,
        cause,
    });
}
