import { createHash } from "node:crypto";
import { fetchAgentUrl } from "./transport/connect.js";
import { errorMessage, trace } from "./debug.js";
import { CURSOR_API_HOST } from "./shared.js";
import { processShared } from "./process-shared.js";
import { CursorAuthError, CursorProtocolError, CursorProviderError, CursorServerError, CursorTransportError, toCursorProviderError, } from "./errors.js";
const DEFAULT_API_BASE = `https://${CURSOR_API_HOST}`;
// In-process memo of the region-specific Run stream origin (agentnUrl). Resolved
// once per process, shared by every copy of this package that the host loads.
// The auth loader warms it and the first startSession reuses it. It is held
// for the process lifetime. Region routing is near-static, and
// re-resolving mid-session would break a held-open bidi Run stream anyway.
//
// Unlike the models/version caches this is NOT persisted to disk. A wrong agent
// host is fatal and silent (HTTP 200 + immediate close, "This region is not
// available for your team"), so persisting it would risk pinning the process —
// or the next process — to a stale region or the legacy global host that some
// accounts reject. Resolving fresh per process is cheap (one unary RPC on the
// API host) and self-heals after a Cursor-side region migration on restart.
//
function normalizeApiBaseURL(baseURL) {
    if (!baseURL)
        return DEFAULT_API_BASE;
    return new URL(baseURL).origin;
}
function resolveCacheKey(token, options) {
    // codeql[js/insufficient-password-hash] -- The token is a high-entropy JWT/API key,
    // and this digest is only an ephemeral memoization key, never a password verifier.
    const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 16);
    return `${tokenHash}|${normalizeApiBaseURL(options.apiBaseURL ?? options.baseURL)}|telem:${options.telemetryEnabled === true}`;
}
const _resolved = processShared("agent-url.resolved.v1", () => new Map());
const _inflight = processShared("agent-url.inflight.v2", () => new Map());
// A shared promise must not reject with another module graph's error instance,
// nor let one caller's replay-safety mutation alter a sibling caller's error.
async function localResult(promise) {
    const result = await promise;
    if ("url" in result)
        return result.url;
    const { message, ...options } = result.failure;
    switch (options.origin) {
        case "auth": throw new CursorAuthError(message, options);
        case "transport": throw new CursorTransportError(message, options);
        case "server": throw new CursorServerError(message, options);
        case "protocol": throw new CursorProtocolError(message, options);
        default: throw new CursorProviderError(message, options);
    }
}
/**
 * Resolve the Run stream origin for this account via the `GetServerConfig`
 * Connect RPC. Memoized for the process lifetime.
 *
 *   - already resolved → return the memo (no fetch)
 *   - otherwise → fetch `agentUrlConfig.agentnUrl` (then `agentUrl`), memoize, return
 *   - fetch fails / no valid `agentUrlConfig` → throw (no global-host fallback)
 *
 * Concurrent callers share a single in-flight fetch.
 */
export async function resolveAgentUrl(token, options = {}) {
    const cacheKey = resolveCacheKey(token, options);
    const memo = _resolved.get(cacheKey);
    if (memo) {
        trace(`agent-url: reuse in-process memo → ${memo}`);
        return memo;
    }
    const inflight = _inflight.get(cacheKey);
    if (inflight) {
        trace("agent-url: awaiting in-flight GetServerConfig");
        return localResult(inflight);
    }
    const promise = (async () => {
        try {
            const url = await fetchAgentUrl(token, options);
            _resolved.set(cacheKey, url);
            trace(`agent-url: resolved via GetServerConfig → ${url}`);
            return { url };
        }
        catch (err) {
            const reason = errorMessage(err);
            trace(`agent-url: GetServerConfig failed (${reason}); no fallback agent host will be used`);
            const failure = toCursorProviderError(err, { replaySafe: true });
            return { failure: {
                    message: failure.message,
                    origin: failure.origin,
                    transient: failure.transient,
                    replaySafe: failure.replaySafe,
                    statusCode: failure.statusCode,
                    grpcStatus: failure.grpcStatus,
                    rstCode: failure.rstCode,
                    code: failure.code,
                    retryAfterMs: failure.retryAfterMs,
                } };
        }
        finally {
            _inflight.delete(cacheKey);
        }
    })();
    _inflight.set(cacheKey, promise);
    return localResult(promise);
}
/** Reset the in-process memo. Tests only. */
export function resetAgentUrlCache() {
    _resolved.clear();
    _inflight.clear();
}
