import { CURSOR_API_HOST, CURSOR_OAUTH_CLIENT_ID, CURSOR_WEBSITE_HOST } from "./shared.js";
import { withAbortDeadline } from "./deadline.js";
import { errorMessage } from "./debug.js";
const API_BASE = `https://${CURSOR_API_HOST}`;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;
/** Cursor IDE aborts its session refresh after 20 s (`_performAccessTokenRefresh`). */
const SESSION_REFRESH_TIMEOUT_MS = 20_000;
/** Server error code Cursor's IDE and CLI both surface as a sign-in policy block. */
const SIGN_IN_POLICY_VIOLATION = "sign_in_policy_violation";
export class AuthExchangeError extends Error {
    cause;
    kind;
    status;
    constructor(message, cause, kind = "transient", status) {
        super(message);
        this.cause = cause;
        this.kind = kind;
        this.status = status;
        this.name = "AuthExchangeError";
    }
}
export class AuthPollError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = "AuthPollError";
    }
}
export class AuthTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = "AuthTimeoutError";
    }
}
// ── Helpers ──
export function isExpiringSoon(jwt, thresholdS = 300) {
    const payload = decodeJwtPayload(jwt);
    if (!payload || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
        return true;
    }
    return payload.exp * 1000 - Date.now() < thresholdS * 1000;
}
export function decodeJwtPayload(jwt) {
    try {
        const segment = jwt.split(".")[1];
        if (!segment)
            return null;
        const json = Buffer.from(segment, "base64url").toString("utf8");
        const payload = JSON.parse(json);
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
/** JWT `exp` claim as epoch milliseconds, or null if missing/malformed. */
export function decodeJwtExpiryMs(jwt) {
    const payload = decodeJwtPayload(jwt);
    if (!payload || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
        return null;
    }
    return payload.exp * 1000;
}
function base64url(bytes) {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
/** A raw Cursor API key (as opposed to a JWT already exchanged from one). */
export function isExchangeableApiKey(value) {
    return value.startsWith("crsr_");
}
// ── Mode A: pass-through auth token ──
export function useAuthToken(token) {
    return { accessToken: token };
}
/**
 * Exchange a raw `crsr_` API key for a short-lived JWT. This is also how an
 * API-key login is renewed: Cursor CLI re-runs the exchange and never uses the
 * returned refresh token (`auth-refresh.ts` → `loginWithApiKey`).
 */
export async function exchangeApiKey(apiKey, baseUrl = API_BASE) {
    return withAbortDeadline(AUTH_REQUEST_TIMEOUT_MS, () => new AuthExchangeError("API key exchange timed out"), async (signal) => {
        let res;
        try {
            res = await fetch(`${baseUrl}/auth/exchange_user_api_key`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: "{}",
                signal,
            });
        }
        catch (cause) {
            throw new AuthExchangeError("API key exchange request failed", cause);
        }
        if (!res.ok) {
            let errorCode;
            if (res.status === 403) {
                errorCode = (await res.json().catch(() => undefined))?.error;
            }
            // Only an authentication refusal says the key itself is bad; rate
            // limits, timeouts, and server errors are worth another attempt.
            const kind = errorCode === SIGN_IN_POLICY_VIOLATION
                ? "policy"
                : res.status === 401 || res.status === 403 ? "rejected" : "transient";
            throw new AuthExchangeError(kind === "policy"
                ? `API key exchange blocked by Cursor sign-in policy (${SIGN_IN_POLICY_VIOLATION})`
                : `API key exchange failed: ${res.status} ${res.statusText}`, undefined, kind, res.status);
        }
        let body;
        try {
            body = await res.json();
        }
        catch (cause) {
            throw new AuthExchangeError("API key exchange returned malformed JSON", cause);
        }
        if (typeof body.accessToken !== "string" || typeof body.refreshToken !== "string") {
            throw new AuthExchangeError("Exchange response missing tokens");
        }
        return { accessToken: body.accessToken, refreshToken: body.refreshToken };
    });
}
/**
 * Renew a browser-login session token, exactly as Cursor's IDE does
 * (`_performAccessTokenRefresh`): `POST /oauth/token` with a refresh_token
 * grant and the IDE's client id. The response carries no new refresh token;
 * the IDE stores the new access token as both, and so must callers.
 *
 * A rejected token is not an HTTP error: Cursor answers 200 with
 * `{"access_token":"","shouldLogout":true}`, so the body decides the outcome.
 * Never throws; every failure is a classified result.
 */
export async function refreshCursorSession(refreshToken, baseUrl = API_BASE) {
    try {
        return await withAbortDeadline(SESSION_REFRESH_TIMEOUT_MS, () => new Error("session refresh timed out"), async (signal) => {
            const res = await fetch(`${baseUrl}/oauth/token`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-cursor-client-type": "cli",
                },
                body: JSON.stringify({
                    grant_type: "refresh_token",
                    client_id: CURSOR_OAUTH_CLIENT_ID,
                    refresh_token: refreshToken,
                }),
                signal,
            });
            if (!res.ok) {
                return {
                    ok: false,
                    kind: "transient",
                    status: res.status,
                    message: `session refresh failed: ${res.status} ${res.statusText}`,
                };
            }
            const body = await res.json().catch(() => undefined);
            if (body?.shouldLogout === true) {
                return body.error === SIGN_IN_POLICY_VIOLATION
                    ? { ok: false, kind: "policy", status: res.status, message: `session blocked by Cursor sign-in policy (${SIGN_IN_POLICY_VIOLATION})` }
                    : { ok: false, kind: "logout", status: res.status, message: "Cursor ended the session (shouldLogout)" };
            }
            // The IDE would store an empty token here; treat it as a failed attempt.
            if (typeof body?.access_token !== "string" || body.access_token === "") {
                return { ok: false, kind: "transient", status: res.status, message: "session refresh returned no access token" };
            }
            return { ok: true, accessToken: body.access_token };
        });
    }
    catch (cause) {
        return {
            ok: false,
            kind: "transient",
            message: `session refresh request failed: ${errorMessage(cause)}`,
        };
    }
}
// ── Mode C: PKCE browser login ──
async function sha256(data) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}
export function generatePkceParams() {
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const verifier = base64url(verifierBytes);
    const uuid = crypto.randomUUID();
    return { verifier, challenge: "", uuid }; // challenge filled async
}
export async function generatePkceChallenge(verifier) {
    const enc = new TextEncoder();
    const hash = await sha256(enc.encode(verifier));
    return base64url(hash);
}
export function buildLoginUrl(challenge, uuid, websiteUrl = `https://${CURSOR_WEBSITE_HOST}`) {
    return `${websiteUrl}/loginDeepControl?challenge=${encodeURIComponent(challenge)}&uuid=${encodeURIComponent(uuid)}&mode=login&redirectTarget=cli`;
}
export async function pollForTokens(uuid, verifier, baseUrl = API_BASE, signal, maxAttempts = 150) {
    let failures = 0;
    for (let i = 0; i < maxAttempts; i++) {
        if (signal?.aborted)
            throw new AuthTimeoutError("Poll cancelled");
        const delay = Math.min(1000 * Math.pow(1.2, i), 10000);
        await new Promise((r) => setTimeout(r, delay));
        try {
            const url = `${baseUrl}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
            const res = await fetch(url);
            if (res.status === 404) {
                failures = 0;
                continue;
            }
            if (!res.ok) {
                failures++;
                if (failures >= 3) {
                    throw new AuthPollError(`Poll failed after ${failures} consecutive errors (last: ${res.status})`);
                }
                continue;
            }
            const body = await res.json();
            if (body.accessToken && body.refreshToken) {
                return { accessToken: body.accessToken, refreshToken: body.refreshToken };
            }
            // 200 OK but missing tokens — same fail-fast policy as the other error
            // paths, otherwise a partial-body server response stalls the full
            // ~5-minute poll budget with no diagnostic.
            failures++;
            if (failures >= 3) {
                throw new AuthPollError("Poll returned 3 consecutive 200 responses without tokens");
            }
        }
        catch (err) {
            if (err instanceof AuthPollError)
                throw err;
            failures++;
            if (failures >= 3) {
                throw new AuthPollError("Poll failed after 3 consecutive network errors", err);
            }
        }
    }
    throw new AuthTimeoutError(`Poll timed out after ${maxAttempts} attempts (~5 min)`);
}
