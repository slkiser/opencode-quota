import { CursorTransportError, CursorProviderError } from "../errors.js";
import http2 from "node:http2";
export declare function buildBaseHeaders(token: string, clientVersion: string, extra?: Record<string, string>): Record<string, string>;
export declare function unaryAvailableModels(token: string, options?: {
    apiBaseURL?: string;
    baseURL?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
}): Promise<Record<string, unknown>>;
/**
 * Cursor Run stream hosts from GetServerConfig / agentBaseURL.
 * Any HTTPS subdomain of cursor.sh is accepted — hostnames vary
 * (agentn.*, agent.*, agent-gcpp-*, api5 / api5lat, …) and may change.
 */
export declare function isAllowedAgentHost(hostname: string): boolean;
/**
 * Normalize a GetServerConfig agent URL to an https origin.
 * Returns null for missing, malformed, non-https, or non-*.cursor.sh hosts.
 */
export declare function normalizeAgentRunOrigin(raw: string | undefined): string | null;
/**
 * Fetch the Cursor server config (a Connect unary RPC on the API host) and
 * return the `agentUrlConfig.agentnUrl` field — the region-specific Run stream
 * origin the server routes this account/team to (e.g. `agentn.us.api5.cursor.sh`).
 *
 * Region-routed accounts can be silently rejected by the wrong regional host, so
 * this lookup fails closed instead of substituting any host on error. Any
 * authoritative `*.cursor.sh` origin from GetServerConfig is accepted.
 */
export declare function fetchAgentUrl(token: string, options?: {
    apiBaseURL?: string;
    baseURL?: string;
    telemetryEnabled?: boolean;
    timeoutMs?: number;
}): Promise<string>;
export declare const RUN_COMPRESS_MIN_BYTES = 1024;
/**
 * Cursor could not take a gzip-compressed Run: HTTP 415, `unimplemented` (how Connect and gRPC
 * refuse an unsupported encoding), or `invalid_argument`/`internal` naming the compression.
 */
export declare function isCompressionRejection(status: {
    httpStatus?: number;
    code?: string;
    message?: string;
}): boolean;
/**
 * Compress a Run's opening request before its stream opens. The stream then writes it at once, so a refusal
 * or HTTP error can only arrive after it went out and still reaches the registered Run.
 */
export declare function compressRunRequestAhead(request: Uint8Array): Promise<void>;
export declare function resetRunCompressionForTests(...uncompressedOrigins: string[]): void;
export type BidiStream = {
    /** A promise while the message waits for compression, its own or an earlier one's; false when backpressured. */
    write(msg: Uint8Array): boolean | void | Promise<boolean>;
    /** Cursor refused this Run for its gzip compression; the origin's later Runs go uncompressed. */
    compressionRejected?(): boolean;
    /**
     * Resolves once a backpressured write has drained. There is no deadline, as
     * in Cursor CLI's transport: a stream error or close (remote or local) settles
     * it, and the read-idle watchdog bounds a stream that stops answering.
     */
    waitForDrain?(): Promise<void>;
    end(): void;
    frames(): AsyncIterable<{
        flags: number;
        payload: Uint8Array;
    }>;
    destroy(): void;
    /** Nothing more can be written: Cursor ended or reset the stream, or it was closed locally. */
    isClosed(): boolean;
    onTerminal(listener: (event: BidiTerminalEvent) => void): () => void;
};
export type BidiTerminalEvent = {
    kind: "remote-clean-close";
} | {
    kind: "remote-error";
    error: CursorProviderError;
} | {
    kind: "local-close";
};
export declare class CursorRunInterruptedError extends CursorTransportError {
    constructor(message?: string, options?: ErrorOptions);
}
export declare function cursorRunTerminationError(input: {
    responseStatus: number;
    responseHeaders?: Record<string, unknown>;
    responseTrailers?: Record<string, unknown>;
    streamError?: Error | null;
}): CursorProviderError;
export declare const HTTP2_SESSION_MAX_AGE_MS: number;
export declare function shouldReuseHttp2Session(state: {
    destroyed: boolean;
    closed: boolean;
}, createdAt: number, now?: number): boolean;
/** Resolve the HTTP/2 connect origin for a Run stream (exported for tests). */
export declare function resolveAgentOrigin(baseURL: string): string;
/** Test cleanup for local HTTP/2 fixtures; production sessions stay process-cached. */
export declare function closeCachedHttp2SessionsForTests(): void;
/** Node-runtime regression hook; production callers use getSession(). */
export declare function installSessionInvalidationForTests(origin: string, session: http2.ClientHttp2Session): void;
/** Node-runtime regression hook: cache a connected local session for `origin`. */
export declare function cacheHttp2SessionForTests(origin: string, session: http2.ClientHttp2Session): void;
export declare function getSession(baseURL: string, options?: {
    pingTimeoutMs?: number;
}): Promise<http2.ClientHttp2Session>;
export declare function frameArrival(frame: object): number | undefined;
export declare function lastFrameArrival(): number;
export declare function bidiRunStream(token: string, options: {
    signal?: AbortSignal;
    baseURL: string;
    headers?: Record<string, string>;
    readIdleMs?: number;
    pingTimeoutMs?: number;
}): Promise<BidiStream>;
export declare function makeRequestId(): string;
