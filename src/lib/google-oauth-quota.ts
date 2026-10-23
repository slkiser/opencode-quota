import type { ErrorFacts } from "../core/errors.js";
import { readProviderConfigString } from "./api-key-resolver.js";
import type {
  GoogleCompanionConfiguredCredentials,
  GoogleCompanionResolver,
} from "./google-companion-credentials.js";
import { type GoogleTokenCache, makeAccountCacheKey } from "./google-token-cache.js";
import { failureFacts, RequestFailedError, requestJson, thrownFacts } from "./http.js";
import { nonEmptyString } from "./json-guards.js";
import {
  activeCredentialRows,
  type CredentialRow,
  readCredentialRows,
  readOAuthLogin,
} from "./opencode-auth.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  loginListIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";
import type { GeminiCliAuthSourceKey, GoogleAgyAuthSourceKey, QuotaError } from "./types.js";

/**
 * The OAuth quota flow shared by Google AGY (Antigravity) and Gemini CLI:
 * an OpenCode login → its account → an access token → one quota request.
 * Each flavor brings its auth keys, endpoint, and response parsing.
 */

const TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";
const TOKEN_TIMEOUT_MS = 8_000;
const TOKEN_EXPIRY_SKEW_MS = 2 * 60_000;
const QUOTA_TIMEOUT_MS = 6_000;

export type GoogleAuthSourceKey = GoogleAgyAuthSourceKey | GeminiCliAuthSourceKey;

export type GoogleAccount<Key extends GoogleAuthSourceKey> = {
  sourceKey: Key;
  refreshToken: string;
  projectId: string;
  email?: string;
  accessToken?: string;
  expiresAt?: number;
};

export type GoogleAuthPresence<Key extends GoogleAuthSourceKey> =
  | { state: "missing"; sourceKey?: undefined; accountCount: 0; validAccountCount: 0 }
  | { state: "present"; sourceKey: Key; accountCount: number; validAccountCount: number }
  | {
      state: "invalid";
      sourceKey?: Key;
      accountCount: number;
      validAccountCount: number;
      error: string;
    };

export type GoogleQuotaResult<Bucket> = { success: true; buckets: Bucket[] } | QuotaError | null;

/** Every OAuth login of one flavor, and the project id its logins fall back to. */
export type GoogleLogins = { rows: CredentialRow[]; configuredProjectId: string | undefined };

/** The logins and companion plugin of one flavor. */
type GoogleAuthFlavor<Key extends GoogleAuthSourceKey> = {
  providerId: "google-agy" | "google-gemini-cli";
  /** Name in messages, e.g. "Gemini CLI quota API error: 500". */
  name: "Google AGY" | "Gemini CLI";
  authKeys: readonly Key[];
  projectIdEnvVar: string;
  /** OpenCode config provider whose `projectId` setting applies. */
  projectIdConfigProvider: string;
  /** Gemini CLI keeps a login OpenCode could not return "present", so its error row shows. */
  failedLoginCountsAsPresent: boolean;
  companion: GoogleCompanionResolver;
};

export type GoogleQuotaFlavor<
  Key extends GoogleAuthSourceKey,
  Response,
  Bucket,
> = GoogleAuthFlavor<Key> & {
  /** Query error when the companion plugin is missing; defaults to the companion's message. */
  missingCompanionError?: string;
  quotaUrl: string;
  quotaHeaders: () => Record<string, string>;
  /** The flavor's access tokens of this process. */
  tokenCache: GoogleTokenCache;
  /** Buckets of one account's quota response; throwing marks the account as failed. */
  toBuckets: (response: Response, account: GoogleAccount<Key>) => Bucket[];
};

type AccessTokenResult = { accessToken: string } | { error: string; facts?: ErrorFacts };

export async function resolveGoogleConfiguredProjectId(
  flavor: { projectIdEnvVar: string; projectIdConfigProvider: string },
  directory: string,
): Promise<string | undefined> {
  return (
    nonEmptyString(process.env[flavor.projectIdEnvVar]) ??
    (await readProviderConfigString(flavor.projectIdConfigProvider, "projectId", directory)) ??
    nonEmptyString(process.env.GOOGLE_CLOUD_PROJECT) ??
    nonEmptyString(process.env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

export async function readGoogleLogins(
  flavor: { authKeys: readonly string[]; projectIdEnvVar: string; projectIdConfigProvider: string },
  directory: string,
): Promise<GoogleLogins> {
  const [rows, configuredProjectId] = await Promise.all([
    readCredentialRows(flavor.authKeys, { methods: ["oauth"] }),
    resolveGoogleConfiguredProjectId(flavor, directory),
  ]);
  return { rows, configuredProjectId };
}

/**
 * One account per usable OAuth login among `rows`, in auth-key order. The refresh value may
 * be packed as `refreshToken|projectId|managedProjectId`. Logins that share a refresh token
 * and project are one account.
 */
export function resolveGoogleAccounts<Key extends GoogleAuthSourceKey>(
  flavor: { authKeys: readonly Key[] },
  rows: readonly CredentialRow[],
  configuredProjectId?: string,
): GoogleAccount<Key>[] {
  const accounts: GoogleAccount<Key>[] = [];
  const seen = new Set<string>();
  for (const sourceKey of flavor.authKeys) {
    for (const row of rows) {
      if (row.integrationId !== sourceKey) continue;
      const login = readOAuthLogin(row);
      // A login OpenCode could not return carries no usable token.
      if (login?.state !== "signed-in") continue;

      const { fields } = login;
      const [packedToken = "", packedProjectId, packedManagedProjectId] = (
        login.refreshToken ?? ""
      ).split("|");
      const refreshToken = packedToken.trim();
      const projectId =
        nonEmptyString(fields.managedProjectId) ??
        nonEmptyString(fields.quotaProjectId) ??
        nonEmptyString(packedManagedProjectId) ??
        nonEmptyString(fields.projectId) ??
        nonEmptyString(fields.projectID) ??
        nonEmptyString(packedProjectId) ??
        nonEmptyString(configuredProjectId);
      if (!refreshToken || !projectId) continue;

      const key = `${refreshToken}\n${projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const email =
        nonEmptyString(fields.email) ??
        nonEmptyString(fields.accountEmail) ??
        nonEmptyString(fields.login);
      accounts.push({
        sourceKey,
        refreshToken,
        projectId,
        ...(email ? { email } : {}),
        ...(login.accessToken ? { accessToken: login.accessToken } : {}),
        ...(login.expiresAt !== undefined ? { expiresAt: login.expiresAt } : {}),
      });
    }
  }
  return accounts;
}

/** The auth state of the logins OpenCode uses: the first login of each auth key. */
export function inspectGoogleAuthPresence<Key extends GoogleAuthSourceKey>(
  flavor: GoogleAuthFlavor<Key>,
  logins: GoogleLogins,
): GoogleAuthPresence<Key> {
  const active = activeCredentialRows(logins.rows);
  const activeLogin = (key: Key) => {
    const row = active.find((candidate) => candidate.integrationId === key);
    return row ? readOAuthLogin(row) : null;
  };
  const oauthKeys = flavor.authKeys.filter((key) => activeLogin(key) !== null);
  if (oauthKeys.length === 0) {
    return { state: "missing", accountCount: 0, validAccountCount: 0 };
  }

  const accounts = resolveGoogleAccounts(flavor, active, logins.configuredProjectId);
  const failedLoginKey = flavor.failedLoginCountsAsPresent
    ? oauthKeys.find((key) => activeLogin(key)?.state === "failed")
    : undefined;
  const presentSourceKey = accounts[0]?.sourceKey ?? failedLoginKey;
  if (!presentSourceKey) {
    return {
      state: "invalid",
      sourceKey: oauthKeys[0],
      accountCount: oauthKeys.length,
      validAccountCount: 0,
      error: `${flavor.name} OAuth auth is missing a refresh token or project id`,
    };
  }
  return {
    state: "present",
    sourceKey: presentSourceKey,
    accountCount: oauthKeys.length,
    validAccountCount: accounts.length,
  };
}

export async function hasGoogleQuotaRuntimeAvailable<Key extends GoogleAuthSourceKey>(
  flavor: GoogleAuthFlavor<Key>,
  directory: string,
): Promise<boolean> {
  const [logins, companion] = await Promise.all([
    readGoogleLogins(flavor, directory),
    flavor.companion.inspect(),
  ]);
  return (
    inspectGoogleAuthPresence(flavor, logins).state === "present" && companion.state === "present"
  );
}

/**
 * Who the flavor is signed in as: the account of every login, plus the companion plugin's
 * client. Null without logins, with a login that has no account (one OpenCode could not return,
 * for example), or without the companion's client.
 */
export async function googleLoginsIdentity<Key extends GoogleAuthSourceKey>(
  flavor: GoogleAuthFlavor<Key>,
  logins: GoogleLogins,
): Promise<ResolvedAuthIdentity | null> {
  const credentials = await flavor.companion.resolveCredentials();
  if (credentials.state !== "configured") return null;

  const accountIdentities = await Promise.all(
    logins.rows.flatMap((row) => {
      const accounts = resolveGoogleAccounts(flavor, [row], logins.configuredProjectId);
      return (accounts.length > 0 ? accounts : [null]).map(async (account) => ({
        row,
        identity: account
          ? await deriveResolvedAuthIdentity({
              providerId: flavor.providerId,
              principal: { kind: "credential", value: account.refreshToken },
              qualifiers: [account.projectId],
            })
          : null,
      }));
    }),
  );
  const [accountsIdentity, companionIdentity] = await Promise.all([
    loginListIdentity(flavor.providerId, accountIdentities),
    deriveResolvedAuthIdentity({
      providerId: `${flavor.providerId}:companion`,
      principal: { kind: "credential", value: credentials.clientSecret },
      qualifiers: [credentials.clientId],
    }),
  ]);
  if (!accountsIdentity || !companionIdentity) return null;

  return composeResolvedAuthIdentities({
    providerId: flavor.providerId,
    identities: [accountsIdentity, companionIdentity],
  });
}

async function refreshAccessToken(
  refreshToken: string,
  credentials: GoogleCompanionConfiguredCredentials,
  timeoutMs: number | undefined,
): Promise<{ accessToken: string; expiresIn: number } | { error: string; facts?: ErrorFacts }> {
  const reply = await requestJson(TOKEN_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    secrets: [credentials.clientSecret, refreshToken],
    timeoutMs: timeoutMs ?? TOKEN_TIMEOUT_MS,
  });
  if (reply.ok) {
    const data = reply.json as { access_token: string; expires_in: number } | null;
    if (!data) return { error: "Token refresh failed" };
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  }
  const { failure } = reply;
  if (failure.kind === "timeout")
    return { error: "Token refresh timeout", facts: failureFacts(failure) };
  if (failure.kind !== "http") return { error: "Token refresh failed" };
  // Google answers a refresh token or client it no longer accepts with 400.
  const facts = failureFacts(failure, failure.status === 400 ? "login_expired" : failure.code);
  try {
    const errorData = JSON.parse(failure.detail) as {
      error?: string;
      error_description?: string;
    } | null;
    if (errorData?.error === "invalid_grant") return { error: "Token revoked", facts };
    return { error: errorData?.error_description || `HTTP ${failure.status}`, facts };
  } catch {
    return { error: `HTTP ${failure.status}`, facts };
  }
}

/** The process cache first, then the login's own unexpired token, then a refresh. */
async function getAccessToken(params: {
  tokenCache: GoogleTokenCache;
  account: GoogleAccount<GoogleAuthSourceKey>;
  credentials: GoogleCompanionConfiguredCredentials;
  timeoutMs: number | undefined;
  force: boolean;
}): Promise<AccessTokenResult> {
  const { tokenCache, account } = params;
  const key = makeAccountCacheKey({
    refreshToken: account.refreshToken,
    projectId: account.projectId,
  });

  if (!params.force) {
    const cached = await tokenCache.get({ key, skewMs: TOKEN_EXPIRY_SKEW_MS });
    if (cached) return { accessToken: cached.accessToken };
    if (
      account.accessToken &&
      typeof account.expiresAt === "number" &&
      account.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS
    ) {
      return { accessToken: account.accessToken };
    }
  }

  const refreshed = await refreshAccessToken(
    account.refreshToken,
    params.credentials,
    params.timeoutMs,
  );
  if ("error" in refreshed) return refreshed;

  await tokenCache.set({
    key,
    entry: {
      accessToken: refreshed.accessToken,
      expiresAt: Date.now() + Math.max(1, refreshed.expiresIn) * 1000,
    },
  });
  return { accessToken: refreshed.accessToken };
}

async function retrieveQuota<Response>(
  flavor: { name: string; quotaUrl: string; quotaHeaders: () => Record<string, string> },
  accessToken: string,
  projectId: string,
  timeoutMs: number | undefined,
): Promise<Response> {
  const reply = await requestJson(flavor.quotaUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...flavor.quotaHeaders(),
    },
    body: JSON.stringify({ project: projectId }),
    secrets: [accessToken],
    timeoutMs: timeoutMs ?? QUOTA_TIMEOUT_MS,
  });
  if (reply.ok) return reply.json as Response;
  const { failure } = reply;
  if (failure.kind === "http" && (failure.status === 401 || failure.status === 403)) {
    throw new RequestFailedError(
      `${flavor.name} quota auth error: ${failure.status}`,
      failureFacts(failure, "login_expired"),
    );
  }
  if (failure.kind === "http") {
    throw new RequestFailedError(
      `${flavor.name} quota API error: ${failure.status}`,
      failureFacts(failure),
    );
  }
  throw new RequestFailedError(failure.detail, failureFacts(failure));
}

/** Retries once with a fresh token when the quota API rejects the token. */
async function fetchAccountBuckets<Key extends GoogleAuthSourceKey, Response, Bucket>(params: {
  flavor: GoogleQuotaFlavor<Key, Response, Bucket>;
  account: GoogleAccount<Key>;
  credentials: GoogleCompanionConfiguredCredentials;
  timeoutMs: number | undefined;
}): Promise<{ buckets: Bucket[] } | { error: string; facts?: ErrorFacts }> {
  const { flavor, account, credentials, timeoutMs } = params;
  const { tokenCache } = flavor;
  try {
    const token = await getAccessToken({
      tokenCache,
      account,
      credentials,
      timeoutMs,
      force: false,
    });
    if ("error" in token) return token;

    let response: Response;
    try {
      response = await retrieveQuota<Response>(
        flavor,
        token.accessToken,
        account.projectId,
        timeoutMs,
      );
    } catch (err) {
      if (thrownFacts(err)?.code !== "login_expired") throw err;
      const retryToken = await getAccessToken({
        tokenCache,
        account,
        credentials,
        timeoutMs,
        force: true,
      });
      if ("error" in retryToken) return retryToken;
      response = await retrieveQuota<Response>(
        flavor,
        retryToken.accessToken,
        account.projectId,
        timeoutMs,
      );
    }

    return { buckets: flavor.toBuckets(response, account) };
  } catch (err) {
    const facts = thrownFacts(err);
    if (facts?.code === "timeout") return { error: "API timeout", facts };
    return { error: err instanceof Error ? err.message : String(err), ...(facts ? { facts } : {}) };
  }
}

/** The quota of the account of one login; null when the login has no usable account. */
export async function queryGoogleQuota<Key extends GoogleAuthSourceKey, Response, Bucket>(
  flavor: GoogleQuotaFlavor<Key, Response, Bucket>,
  options: { requestTimeoutMs?: number; login: CredentialRow; directory: string },
): Promise<GoogleQuotaResult<Bucket>> {
  const configuredProjectId = await resolveGoogleConfiguredProjectId(flavor, options.directory);
  const [account] = resolveGoogleAccounts(flavor, [options.login], configuredProjectId);
  if (!account) return null;

  const credentials = await flavor.companion.resolveCredentials();
  if (credentials.state !== "configured") {
    const error =
      credentials.state === "missing"
        ? (flavor.missingCompanionError ?? credentials.error)
        : credentials.error;
    return { success: false, error };
  }

  const result = await fetchAccountBuckets({
    flavor,
    account,
    credentials,
    timeoutMs: options.requestTimeoutMs,
  });
  const noData = `No ${flavor.name} quota data available`;
  if ("error" in result) {
    return {
      success: false,
      error: result.error || noData,
      ...(result.facts ? { facts: result.facts } : {}),
    };
  }
  if (result.buckets.length === 0) return { success: false, error: noData };
  return { success: true, buckets: result.buckets };
}
