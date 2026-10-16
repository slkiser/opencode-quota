import { CURSOR_WEBSITE_HOST } from "../shared.js";
import { cursorApiBaseURL } from "../plugin-core.js";
import { buildLoginUrl, decodeJwtExpiryMs, generatePkceChallenge, generatePkceParams, isExchangeableApiKey, pollForTokens, } from "../auth.js";
import { renewSessionIfDue, resolveApiKeyToken, } from "../auth-renewal.js";
import { CursorAuthError, CursorProviderError } from "../errors.js";
import { errorMessage } from "../debug.js";
import { CURSOR_INTEGRATION_ID } from "./catalog.js";
/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `auth` hook (`methods` + `loader`).
 *
 * Unlike the 1.18 v2 API (where OAuth registration is Effect-valued), 2.0 takes
 * plain Promises, so the PKCE flow from `src/auth.ts` ports across unchanged.
 */
export const CURSOR_OAUTH_METHOD_ID = "oauth";
/** Env vars that can supply a Cursor API key without running /connect. */
export const CURSOR_ENV_NAMES = ["CURSOR_API_KEY"];
function websiteURL() {
    return process.env.CURSOR_WEBSITE_URL ?? `https://${CURSOR_WEBSITE_HOST}`;
}
/** `expires` of a session credential: the JWT's own expiry, as OpenCode's built-in OAuth integrations store it. */
function sessionExpires(token) {
    return decodeJwtExpiryMs(token) ?? Date.now();
}
function sessionTokensOf(credential) {
    return { accessToken: credential.access, refreshToken: credential.refresh || credential.access };
}
/** Browser (PKCE) login: open URL, then poll until Cursor hands back tokens. */
async function authorizeOAuth() {
    const params = generatePkceParams();
    const challenge = await generatePkceChallenge(params.verifier);
    const apiBaseURL = cursorApiBaseURL();
    const url = buildLoginUrl(challenge, params.uuid, websiteURL());
    return {
        url,
        instructions: "Open this URL in a browser to sign in to Cursor",
        mode: "auto",
        callback: pollForTokens(params.uuid, params.verifier, apiBaseURL).then((result) => ({
            type: "oauth",
            methodID: CURSOR_OAUTH_METHOD_ID,
            access: result.accessToken,
            refresh: result.refreshToken,
            expires: sessionExpires(result.accessToken),
        })),
    };
}
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
export async function refreshOAuth(credential) {
    const renewal = await renewSessionIfDue(sessionTokensOf(credential), { baseUrl: cursorApiBaseURL() });
    const methodID = credential.methodID || CURSOR_OAUTH_METHOD_ID;
    const metadata = credential.metadata === undefined ? {} : { metadata: credential.metadata };
    if (renewal.renewed) {
        return {
            type: "oauth",
            methodID,
            access: renewal.accessToken,
            refresh: renewal.accessToken,
            expires: sessionExpires(renewal.accessToken),
            ...metadata,
        };
    }
    return {
        ...credential,
        methodID,
        expires: renewal.retryAt ?? sessionExpires(credential.access),
    };
}
/** Register the Cursor integration and its three connection methods. */
export function applyCursorIntegration(draft) {
    draft.update(CURSOR_INTEGRATION_ID, (integration) => {
        integration.id = CURSOR_INTEGRATION_ID;
        integration.name = "Cursor";
    });
    draft.method.update({
        integrationID: CURSOR_INTEGRATION_ID,
        method: {
            id: CURSOR_OAUTH_METHOD_ID,
            type: "oauth",
            label: "Cursor account (browser login)",
        },
        authorize: authorizeOAuth,
        refresh: refreshOAuth,
    });
    draft.method.update({
        integrationID: CURSOR_INTEGRATION_ID,
        method: { type: "key", label: "API key (cursor.com/settings)" },
    });
    draft.method.update({
        integrationID: CURSOR_INTEGRATION_ID,
        method: { type: "env", names: CURSOR_ENV_NAMES },
    });
}
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
export async function accessTokenFromCredential(credential, request = {}) {
    const force = request.forceRefresh === true;
    if (credential?.type === "oauth") {
        return (await renewSessionIfDue(sessionTokensOf(credential), { baseUrl: cursorApiBaseURL(), force })).accessToken;
    }
    if (credential?.type === "key") {
        if (!isExchangeableApiKey(credential.key))
            return credential.key;
        return (await resolveApiKeyToken(credential.key, { baseUrl: cursorApiBaseURL(), force })).accessToken;
    }
    throw new CursorAuthError("No Cursor login found; connect Cursor first", { code: "no_credential" });
}
/**
 * Current access token of the active Cursor connection, for a Run. Throws a
 * `CursorAuthError` that says why when there is none.
 */
export async function requireCursorAccessToken(integration, request = {}) {
    let credential;
    try {
        const connection = await integration.connection.active(CURSOR_INTEGRATION_ID);
        credential = connection ? await integration.connection.resolve(connection) : undefined;
    }
    catch (error) {
        // The host's resolve runs our refreshOAuth; keep its classified error.
        if (error instanceof CursorProviderError)
            throw error;
        throw new CursorAuthError(`Cursor login could not be loaded (${errorMessage(error)})`, { cause: error });
    }
    return accessTokenFromCredential(credential, request);
}
/** Access token of the active Cursor connection, or undefined (model discovery). */
export async function resolveCursorAccessToken(integration) {
    try {
        return await requireCursorAccessToken(integration);
    }
    catch {
        return undefined;
    }
}
