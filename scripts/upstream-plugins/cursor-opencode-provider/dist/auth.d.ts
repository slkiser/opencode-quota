/**
 * How an API key exchange failed. A policy block (403
 * `sign_in_policy_violation`, as Cursor CLI's `loginWithApiKey` reports it) and
 * an authentication refusal (401/403) are final for that key; anything else —
 * rate limit, timeout, server or network failure — is worth retrying later.
 */
export type AuthExchangeFailureKind = "policy" | "rejected" | "transient";
export declare class AuthExchangeError extends Error {
    cause?: unknown | undefined;
    readonly kind: AuthExchangeFailureKind;
    readonly status?: number | undefined;
    constructor(message: string, cause?: unknown | undefined, kind?: AuthExchangeFailureKind, status?: number | undefined);
}
export declare class AuthPollError extends Error {
    cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
export declare class AuthTimeoutError extends Error {
    constructor(message: string);
}
export declare function isExpiringSoon(jwt: string, thresholdS?: number): boolean;
export declare function decodeJwtPayload(jwt: string): Record<string, unknown> | null;
/** JWT `exp` claim as epoch milliseconds, or null if missing/malformed. */
export declare function decodeJwtExpiryMs(jwt: string): number | null;
/** A raw Cursor API key (as opposed to a JWT already exchanged from one). */
export declare function isExchangeableApiKey(value: string): boolean;
export declare function useAuthToken(token: string): {
    accessToken: string;
};
export type TokenPair = {
    accessToken: string;
    refreshToken: string;
};
/**
 * Exchange a raw `crsr_` API key for a short-lived JWT. This is also how an
 * API-key login is renewed: Cursor CLI re-runs the exchange and never uses the
 * returned refresh token (`auth-refresh.ts` → `loginWithApiKey`).
 */
export declare function exchangeApiKey(apiKey: string, baseUrl?: string): Promise<TokenPair>;
export type SessionRefreshResult = {
    ok: true;
    accessToken: string;
} | {
    ok: false;
    /**
     * `logout`: Cursor ended the session. `policy`: a sign-in policy blocks
     * it. Both are final for this token. `transient`: try again later.
     */
    kind: "logout" | "policy" | "transient";
    status?: number;
    message: string;
};
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
export declare function refreshCursorSession(refreshToken: string, baseUrl?: string): Promise<SessionRefreshResult>;
export type PkceParams = {
    verifier: string;
    challenge: string;
    uuid: string;
};
export declare function generatePkceParams(): PkceParams;
export declare function generatePkceChallenge(verifier: string): Promise<string>;
export declare function buildLoginUrl(challenge: string, uuid: string, websiteUrl?: string): string;
export declare function pollForTokens(uuid: string, verifier: string, baseUrl?: string, signal?: AbortSignal, maxAttempts?: number): Promise<TokenPair>;
