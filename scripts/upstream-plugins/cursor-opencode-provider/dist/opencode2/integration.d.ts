import { type AccessTokenRequest } from "../auth-renewal.js";
import type { CredentialOAuth, CredentialValue, IntegrationDomain, IntegrationDraft } from "./types.js";
/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `auth` hook (`methods` + `loader`).
 *
 * Unlike the 1.18 v2 API (where OAuth registration is Effect-valued), 2.0 takes
 * plain Promises, so the PKCE flow from `src/auth.ts` ports across unchanged.
 */
export declare const CURSOR_OAUTH_METHOD_ID = "oauth";
/** Env vars that can supply a Cursor API key without running /connect. */
export declare const CURSOR_ENV_NAMES: string[];
/**
 * Host-driven session renewal (`POST /oauth/token`, as Cursor's IDE does).
 * OpenCode 2.0 calls this when the stored `expires` is within five minutes
 * (`packages/core/src/integration.ts`, `connection.resolve`) and persists the
 * result. A session this process already renewed in memory is handed over
 * instead of renewed again. A transient failure returns the unchanged session
 * with `expires` moved to the next allowed attempt, so the host keeps working
 * and asks again later; only a session Cursor ended, or one that expired
 * unrenewed, throws.
 */
export declare function refreshOAuth(credential: CredentialOAuth): Promise<CredentialOAuth>;
/** Register the Cursor integration and its three connection methods. */
export declare function applyCursorIntegration(draft: IntegrationDraft): void;
/**
 * Turn a stored credential into a Cursor access token. The two credential
 * kinds are handled separately and never substitute for each other.
 *
 * - `oauth`: the session token, renewed in memory once it is due by Cursor's
 *   IDE window (the host itself refreshes only in the last five minutes; it
 *   then persists the renewal through `refreshOAuth`).
 * - `key`: a raw `crsr_…` API key (from /connect or `CURSOR_API_KEY`),
 *   exchanged for a short-lived JWT and re-exchanged near its expiry. Any
 *   other value is an already-issued token and is used as-is.
 *
 * Throws `CursorAuthError` when no usable token can be produced.
 */
export declare function accessTokenFromCredential(credential: CredentialValue | undefined, request?: AccessTokenRequest): Promise<string>;
/**
 * Current access token of the active Cursor connection, for a Run. Throws a
 * `CursorAuthError` that says why when there is none.
 */
export declare function requireCursorAccessToken(integration: IntegrationDomain, request?: AccessTokenRequest): Promise<string>;
/** Access token of the active Cursor connection, or undefined (model discovery). */
export declare function resolveCursorAccessToken(integration: IntegrationDomain): Promise<string | undefined>;
