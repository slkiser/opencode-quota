/** Cursor IDE renews a session once less than this remains (`hir = 1272h`). */
export declare const SESSION_RENEWAL_WINDOW_MS: number;
/** Never renew a session token younger than this, whatever its lifetime. */
export declare const SESSION_MIN_AGE_MS = 3600000;
export type TokenTimes = {
    issuedAtMs?: number;
    expiresAtMs?: number;
};
/**
 * Issue and expiry times of a Cursor JWT. Cursor session tokens carry the
 * issue time in a `time` claim (seconds, as a string); standard `iat` is used
 * when present instead.
 */
export declare function tokenTimes(token: string): TokenTimes;
/**
 * When a session token is due for renewal: 1272 h before expiry, but never
 * within an hour of issue. Undefined when the token has no readable expiry.
 */
export declare function sessionRenewalDueAt(token: string): number | undefined;
export type SessionTokens = {
    accessToken: string;
    refreshToken: string;
};
export type SessionRenewal = {
    accessToken: string;
    /** True when `accessToken` differs from the stored one and should be persisted. */
    renewed: boolean;
    /** Set while a failed renewal is backing off: when the next attempt is allowed. */
    retryAt?: number;
};
/**
 * Follow renewals this process already made, so a caller still holding an
 * older stored credential (persisting failed, or a host that persists only
 * later) gets the newest token instead of renewing again.
 */
export declare function latestSessionTokens(tokens: SessionTokens): SessionTokens;
export declare function isSessionRenewalDue(token: string, now?: number): boolean;
/**
 * Return a usable session token, renewing it first when it is due (or when
 * `force` is set after Cursor rejected it). Renewal failures that leave the
 * current token valid keep it; a session Cursor ended, or one that expired
 * and could not be renewed, raises `CursorAuthError`.
 */
export declare function renewSessionIfDue(tokens: SessionTokens, options?: {
    baseUrl?: string;
    force?: boolean;
}): Promise<SessionRenewal>;
export type ApiKeyToken = {
    accessToken: string;
    /** True when `accessToken` differs from the stored `seed` and should be persisted. */
    renewed: boolean;
};
/**
 * JWT for a raw `crsr_` API key: the cached or `seed` JWT while it is not
 * within five minutes of expiry, otherwise a fresh exchange. Cached per API
 * base URL and key. Never returns the raw key itself.
 */
export declare function resolveApiKeyToken(apiKey: string, options?: {
    baseUrl?: string;
    seed?: string;
    force?: boolean;
}): Promise<ApiKeyToken>;
export type AccessTokenRequest = {
    forceRefresh?: boolean;
};
/** Host-supplied source of the current Cursor access token. */
export type AccessTokenProvider = (request?: AccessTokenRequest) => Promise<string>;
/**
 * Bearer token for a Cursor request. One credential source is used, in this
 * order, and none of them falls back to another:
 *
 * 1. `getAccessToken` — the host resolves (and renews) the token per request.
 * 2. `accessToken` — sent as-is.
 * 3. `apiKey` — a raw `crsr_` key is exchanged and renewed; any other value is
 *    a token a host forwarded through the generic API-key slot, sent as-is.
 */
export declare function resolveBearerToken(input: {
    getAccessToken?: AccessTokenProvider;
    accessToken?: string;
    apiKey?: string;
    baseUrl?: string;
    forceRefresh?: boolean;
}): Promise<string>;
/** Reset all renewal state (tests). */
export declare function resetAuthRenewalState(): void;
