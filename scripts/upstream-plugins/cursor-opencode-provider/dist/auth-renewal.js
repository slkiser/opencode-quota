import { CURSOR_API_HOST, TOKEN_EXPIRY_THRESHOLD_S } from "./shared.js";
import { AuthExchangeError, decodeJwtPayload, exchangeApiKey, isExchangeableApiKey, isExpiringSoon, refreshCursorSession, } from "./auth.js";
// Failure details quote HTTP status text ("503 Service Unavailable"), and
// OpenCode's SessionRetry keys off such words in provider error messages.
import { CursorAuthError, CursorServerError, sanitizeHostTerminalMessage } from "./errors.js";
import { errorMessage, trace } from "./debug.js";
// Credential renewal policy. The two Cursor credential kinds are renewed by
// independent paths and never stand in for each other:
//
// - Browser-login session (OAuth): `POST /oauth/token`, the way Cursor's IDE
//   renews it, starting once less than 1272 h of its 60-day life remain.
// - API key: re-exchange the raw `crsr_` key when the exchanged JWT nears
//   expiry, the way Cursor CLI renews it. Its refresh token is never used.
//
// Renewal happens only on demand, when a request needs a token, as OpenCode's
// own OAuth providers do (a per-request `fetch` that reads `getAuth()`); there
// is no timer. Both keep the current token through a transient failure while
// it is still valid, back off between attempts, and latch final failures so
// they are not retried for the same credential.
const API_BASE = `https://${CURSOR_API_HOST}`;
/** Cursor IDE renews a session once less than this remains (`hir = 1272h`). */
export const SESSION_RENEWAL_WINDOW_MS = 1272 * 3_600_000;
/** Never renew a session token younger than this, whatever its lifetime. */
export const SESSION_MIN_AGE_MS = 3_600_000;
/** A token is still worth sending while it has at least this long left. */
const USABLE_MARGIN_MS = 30_000;
const BACKOFF_INITIAL_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** Remember at most this many in-process session renewals. */
const MAX_SESSION_SUCCESSORS = 32;
const SIGN_IN_AGAIN = "sign in to Cursor again";
/**
 * Issue and expiry times of a Cursor JWT. Cursor session tokens carry the
 * issue time in a `time` claim (seconds, as a string); standard `iat` is used
 * when present instead.
 */
export function tokenTimes(token) {
    const payload = decodeJwtPayload(token);
    if (!payload)
        return {};
    const seconds = (value) => {
        const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
        return typeof n === "number" && Number.isFinite(n) ? n * 1000 : undefined;
    };
    const expiresAtMs = seconds(payload.exp);
    const issuedAtMs = seconds(payload.iat) ?? seconds(payload.time);
    return {
        ...(issuedAtMs !== undefined ? { issuedAtMs } : {}),
        ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    };
}
/**
 * When a session token is due for renewal: 1272 h before expiry, but never
 * within an hour of issue. Undefined when the token has no readable expiry.
 */
export function sessionRenewalDueAt(token) {
    const { issuedAtMs, expiresAtMs } = tokenTimes(token);
    if (expiresAtMs === undefined)
        return undefined;
    const due = expiresAtMs - SESSION_RENEWAL_WINDOW_MS;
    return issuedAtMs === undefined ? due : Math.max(due, issuedAtMs + SESSION_MIN_AGE_MS);
}
function isUsable(token, now) {
    const { expiresAtMs } = tokenTimes(token);
    return expiresAtMs === undefined || expiresAtMs - now > USABLE_MARGIN_MS;
}
/** The token that stays valid longer (the first one on a tie or unknown expiry). */
function longerLived(a, b) {
    const aExp = tokenTimes(a).expiresAtMs;
    const bExp = tokenTimes(b).expiresAtMs;
    return bExp !== undefined && (aExp === undefined || bExp > aExp) ? b : a;
}
function isoTime(ms) {
    return ms === undefined ? "unknown" : new Date(ms).toISOString();
}
function backoffMs(failures) {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** Math.max(0, failures - 1));
}
function stateFor(map, key) {
    let state = map.get(key);
    if (!state) {
        state = { failures: 0 };
        map.set(key, state);
    }
    return state;
}
function recordTransientFailure(state, message) {
    state.failures++;
    state.retryAt = Date.now() + backoffMs(state.failures);
    state.lastFailure = message;
}
function recordSuccess(state) {
    state.failures = 0;
    state.retryAt = undefined;
    state.lastFailure = undefined;
}
const sessionStates = new Map();
/** Stored refresh token → newer session token this process obtained for it. */
const sessionSuccessors = new Map();
/**
 * Follow renewals this process already made, so a caller still holding an
 * older stored credential (persisting failed, or a host that persists only
 * later) gets the newest token instead of renewing again.
 */
export function latestSessionTokens(tokens) {
    let current = tokens;
    for (let hops = 0; hops < MAX_SESSION_SUCCESSORS; hops++) {
        const next = sessionSuccessors.get(current.refreshToken);
        if (!next || next === current.refreshToken)
            break;
        current = { accessToken: next, refreshToken: next };
    }
    return longerLived(tokens.accessToken, current.accessToken) === current.accessToken ? current : tokens;
}
function rememberSuccessor(refreshToken, accessToken) {
    sessionSuccessors.delete(refreshToken);
    sessionSuccessors.set(refreshToken, accessToken);
    while (sessionSuccessors.size > MAX_SESSION_SUCCESSORS) {
        const oldest = sessionSuccessors.keys().next().value;
        if (oldest === undefined)
            break;
        sessionSuccessors.delete(oldest);
    }
}
export function isSessionRenewalDue(token, now = Date.now()) {
    const due = sessionRenewalDueAt(token);
    return due !== undefined && now >= due;
}
/**
 * Return a usable session token, renewing it first when it is due (or when
 * `force` is set after Cursor rejected it). Renewal failures that leave the
 * current token valid keep it; a session Cursor ended, or one that expired
 * and could not be renewed, raises `CursorAuthError`.
 */
export async function renewSessionIfDue(tokens, options = {}) {
    const baseUrl = options.baseUrl ?? API_BASE;
    const base = latestSessionTokens(tokens);
    const fromMemory = base.accessToken !== tokens.accessToken;
    if (!options.force && !isSessionRenewalDue(base.accessToken)) {
        return { accessToken: base.accessToken, renewed: fromMemory };
    }
    const state = stateFor(sessionStates, `${baseUrl}\0${base.refreshToken}`);
    if (!state.terminal && (options.force || state.retryAt === undefined || Date.now() >= state.retryAt)) {
        state.inflight ??= (async () => {
            const result = await refreshCursorSession(base.refreshToken, baseUrl);
            if (result.ok) {
                const { expiresAtMs } = tokenTimes(result.accessToken);
                if (expiresAtMs === undefined) {
                    recordTransientFailure(state, "session refresh returned a token without expiry");
                }
                else {
                    rememberSuccessor(base.refreshToken, result.accessToken);
                    recordSuccess(state);
                    trace(`auth: session renewed exp=${isoTime(expiresAtMs)}`);
                    return;
                }
            }
            else if (result.kind === "transient") {
                recordTransientFailure(state, result.message);
            }
            else {
                state.terminal = new CursorAuthError(result.kind === "policy"
                    ? `Cursor sign-in policy blocks this login (sign_in_policy_violation); ${SIGN_IN_AGAIN} with an allowed account`
                    : `Cursor ended this login session; ${SIGN_IN_AGAIN}`, { code: result.kind === "policy" ? "sign_in_policy_violation" : "session_logout", statusCode: result.status });
                trace(`auth: session renewal final failure kind=${result.kind}`);
                return;
            }
            trace(`auth: session renewal failed (${state.lastFailure}) attempt=${state.failures} ` +
                `retryAt=${isoTime(state.retryAt)} currentExp=${isoTime(tokenTimes(base.accessToken).expiresAtMs)}`);
        })().finally(() => {
            state.inflight = undefined;
        });
        await state.inflight;
    }
    const renewed = latestSessionTokens(base);
    if (renewed.accessToken !== base.accessToken) {
        return { accessToken: renewed.accessToken, renewed: true };
    }
    if (state.terminal)
        throw state.terminal;
    if (!isUsable(base.accessToken, Date.now())) {
        throw new CursorAuthError(`Cursor login expired and could not be renewed (${sanitizeHostTerminalMessage(state.lastFailure ?? "no renewal attempt allowed yet")}); ${SIGN_IN_AGAIN}`, { code: "session_expired" });
    }
    return {
        accessToken: base.accessToken,
        renewed: fromMemory,
        ...(state.retryAt !== undefined ? { retryAt: state.retryAt } : {}),
    };
}
// ── API key ──
const apiKeyStates = new Map();
/**
 * JWT for a raw `crsr_` API key: the cached or `seed` JWT while it is not
 * within five minutes of expiry, otherwise a fresh exchange. Cached per API
 * base URL and key. Never returns the raw key itself.
 */
export async function resolveApiKeyToken(apiKey, options = {}) {
    if (!isExchangeableApiKey(apiKey)) {
        throw new CursorAuthError("Cursor API key must start with crsr_");
    }
    const baseUrl = options.baseUrl ?? API_BASE;
    const state = stateFor(apiKeyStates, `${baseUrl}\0${apiKey}`);
    const seed = options.seed && !isExchangeableApiKey(options.seed) && tokenTimes(options.seed).expiresAtMs !== undefined
        ? options.seed
        : undefined;
    if (seed)
        state.token = state.token ? longerLived(state.token, seed) : seed;
    const result = (token) => ({ accessToken: token, renewed: token !== seed });
    if (state.token && !options.force && !isExpiringSoon(state.token, TOKEN_EXPIRY_THRESHOLD_S)) {
        return result(state.token);
    }
    if (!state.terminal && (options.force || state.retryAt === undefined || Date.now() >= state.retryAt)) {
        state.inflight ??= (async () => {
            try {
                const pair = await exchangeApiKey(apiKey, baseUrl);
                state.token = state.token ? longerLived(state.token, pair.accessToken) : pair.accessToken;
                recordSuccess(state);
                trace(`auth: API key exchanged exp=${isoTime(tokenTimes(pair.accessToken).expiresAtMs)}`);
            }
            catch (error) {
                const kind = error instanceof AuthExchangeError ? error.kind : "transient";
                if (kind === "transient") {
                    recordTransientFailure(state, errorMessage(error));
                    trace(`auth: API key exchange failed (${state.lastFailure}) attempt=${state.failures} retryAt=${isoTime(state.retryAt)}`);
                }
                else {
                    const status = error instanceof AuthExchangeError ? error.status : undefined;
                    state.terminal = new CursorAuthError(kind === "policy"
                        ? "Cursor sign-in policy blocks this API key (sign_in_policy_violation); use an allowed account"
                        : `Cursor rejected the API key${status ? ` (HTTP ${status})` : ""}; create a new key and sign in with it`, { code: kind === "policy" ? "sign_in_policy_violation" : "api_key_rejected", ...(status ? { statusCode: status } : {}) });
                    trace(`auth: API key exchange final failure kind=${kind} status=${status ?? "none"}`);
                }
            }
        })().finally(() => {
            state.inflight = undefined;
        });
        await state.inflight;
    }
    // A fresh exchange is always usable; an older token only until it expires.
    if (state.token && isUsable(state.token, Date.now()))
        return result(state.token);
    if (state.terminal)
        throw state.terminal;
    throw new CursorServerError(`Cursor API key exchange failed (${sanitizeHostTerminalMessage(state.lastFailure ?? "waiting before the next attempt")}); it is retried automatically`, { transient: true, replaySafe: true });
}
/**
 * Bearer token for a Cursor request. One credential source is used, in this
 * order, and none of them falls back to another:
 *
 * 1. `getAccessToken` — the host resolves (and renews) the token per request.
 * 2. `accessToken` — sent as-is.
 * 3. `apiKey` — a raw `crsr_` key is exchanged and renewed; any other value is
 *    a token a host forwarded through the generic API-key slot, sent as-is.
 */
export async function resolveBearerToken(input) {
    let token;
    if (input.getAccessToken) {
        token = await input.getAccessToken(input.forceRefresh ? { forceRefresh: true } : undefined);
    }
    else if (input.accessToken) {
        token = input.accessToken;
    }
    else if (input.apiKey) {
        token = isExchangeableApiKey(input.apiKey)
            ? (await resolveApiKeyToken(input.apiKey, { baseUrl: input.baseUrl, force: input.forceRefresh })).accessToken
            : input.apiKey;
    }
    else {
        throw new CursorAuthError("Cursor provider: no access token or API key provided");
    }
    if (!token)
        throw new CursorAuthError(`Cursor provider: no access token available; ${SIGN_IN_AGAIN}`);
    if (isExchangeableApiKey(token)) {
        // A raw key is never a valid Bearer token; Cursor answers 401.
        throw new CursorAuthError("Cursor provider: a raw crsr_ API key was supplied as an access token; pass it as apiKey");
    }
    return token;
}
/** Reset all renewal state (tests). */
export function resetAuthRenewalState() {
    sessionStates.clear();
    sessionSuccessors.clear();
    apiKeyStates.clear();
}
