import { readGlobalProviderConfigString } from "./api-key-resolver.js";
import type {
  GoogleCompanionConfiguredCredentials,
  GoogleCompanionResolver,
} from "./google-companion-credentials.js";
import {
  getCachedAccessToken,
  makeAccountCacheKey,
  setCachedAccessToken,
} from "./google-token-cache.js";
import { fetchWithTimeout } from "./http.js";
import { nonEmptyString } from "./json-guards.js";
import {
  activeCredentialRowsAuthData,
  type CredentialRow,
  credentialRowAuthData,
  readCredentialRows,
} from "./opencode-auth.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  loginListIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";
import type {
  AuthData,
  GeminiCliAuthSourceKey,
  GoogleAgyAuthSourceKey,
  QuotaError,
} from "./types.js";

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
  /** Buckets of one account's quota response; throwing marks the account as failed. */
  toBuckets: (response: Response, account: GoogleAccount<Key>) => Bucket[];
};

type AccessTokenResult = { accessToken: string } | { error: string };

export async function resolveGoogleConfiguredProjectId(flavor: {
  projectIdEnvVar: string;
  projectIdConfigProvider: string;
}): Promise<string | undefined> {
  return (
    nonEmptyString(process.env[flavor.projectIdEnvVar]) ??
    (await readGlobalProviderConfigString(flavor.projectIdConfigProvider, "projectId")) ??
    nonEmptyString(process.env.GOOGLE_CLOUD_PROJECT) ??
    nonEmptyString(process.env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

export async function readGoogleLogins(flavor: {
  authKeys: readonly string[];
  projectIdEnvVar: string;
  projectIdConfigProvider: string;
}): Promise<GoogleLogins> {
  const [rows, configuredProjectId] = await Promise.all([
    readCredentialRows(flavor.authKeys, { methods: ["oauth"] }),
    resolveGoogleConfiguredProjectId(flavor),
  ]);
  return { rows, configuredProjectId };
}

/**
 * One account per usable OAuth login, in auth-key order. The refresh value may
 * be packed as `refreshToken|projectId|managedProjectId`. Logins that share a
 * refresh token and project are one account.
 */
export function resolveGoogleAccounts<Key extends GoogleAuthSourceKey>(
  flavor: { authKeys: readonly Key[] },
  auth: AuthData | null | undefined,
  configuredProjectId?: string,
): GoogleAccount<Key>[] {
  if (!auth) return [];

  const accounts: GoogleAccount<Key>[] = [];
  const seen = new Set<string>();
  for (const sourceKey of flavor.authKeys) {
    const entry = auth[sourceKey];
    // A login OpenCode could not return carries no usable token.
    if (entry?.type !== "oauth" || entry.resolveError !== undefined) continue;

    const [packedToken = "", packedProjectId, packedManagedProjectId] = (entry.refresh ?? "").split(
      "|",
    );
    const refreshToken = packedToken.trim();
    const projectId =
      nonEmptyString(entry.managedProjectId) ??
      nonEmptyString(entry.quotaProjectId) ??
      nonEmptyString(packedManagedProjectId) ??
      nonEmptyString(entry.projectId) ??
      nonEmptyString(entry.projectID) ??
      nonEmptyString(packedProjectId) ??
      nonEmptyString(configuredProjectId);
    if (!refreshToken || !projectId) continue;

    const key = `${refreshToken}\n${projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const email =
      nonEmptyString(entry.email) ??
      nonEmptyString(entry.accountEmail) ??
      nonEmptyString(entry.login);
    const accessToken = nonEmptyString(entry.access);
    accounts.push({
      sourceKey,
      refreshToken,
      projectId,
      ...(email ? { email } : {}),
      ...(accessToken ? { accessToken } : {}),
      ...(typeof entry.expires === "number" ? { expiresAt: entry.expires } : {}),
    });
  }
  return accounts;
}

/** The auth state of the logins OpenCode uses: the first login of each auth key. */
export function inspectGoogleAuthPresence<Key extends GoogleAuthSourceKey>(
  flavor: GoogleAuthFlavor<Key>,
  logins: GoogleLogins,
): GoogleAuthPresence<Key> {
  const auth = activeCredentialRowsAuthData(logins.rows);
  const oauthKeys = flavor.authKeys.filter((key) => auth?.[key]?.type === "oauth");
  if (oauthKeys.length === 0) {
    return { state: "missing", accountCount: 0, validAccountCount: 0 };
  }

  const accounts = resolveGoogleAccounts(flavor, auth, logins.configuredProjectId);
  const failedLoginKey = flavor.failedLoginCountsAsPresent
    ? oauthKeys.find((key) => auth?.[key]?.resolveError !== undefined)
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
): Promise<boolean> {
  const [logins, companion] = await Promise.all([
    readGoogleLogins(flavor),
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
      const accounts = resolveGoogleAccounts(
        flavor,
        credentialRowAuthData(row),
        logins.configuredProjectId,
      );
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
): Promise<{ accessToken: string; expiresIn: number } | { error: string }> {
  try {
    return await fetchWithTimeout(TOKEN_REFRESH_URL, {
      request: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      },
      timeoutMs: timeoutMs ?? TOKEN_TIMEOUT_MS,
      consume: async (response, timeoutSignal) => {
        if (!response.ok) {
          try {
            const errorData = (await response.json()) as {
              error?: string;
              error_description?: string;
            };
            if (errorData.error === "invalid_grant") return { error: "Token revoked" };
            return { error: errorData.error_description || `HTTP ${response.status}` };
          } catch (error) {
            if (timeoutSignal.aborted) throw error;
            return { error: `HTTP ${response.status}` };
          }
        }

        const data = (await response.json()) as { access_token: string; expires_in: number };
        return { accessToken: data.access_token, expiresIn: data.expires_in };
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      return { error: "Token refresh timeout" };
    }
    return { error: "Token refresh failed" };
  }
}

/** The process cache first, then the login's own unexpired token, then a refresh. */
async function getAccessToken(params: {
  account: GoogleAccount<GoogleAuthSourceKey>;
  credentials: GoogleCompanionConfiguredCredentials;
  timeoutMs: number | undefined;
  force: boolean;
}): Promise<AccessTokenResult> {
  const { account } = params;
  const key = makeAccountCacheKey({
    refreshToken: account.refreshToken,
    projectId: account.projectId,
  });

  if (!params.force) {
    const cached = await getCachedAccessToken({ key, skewMs: TOKEN_EXPIRY_SKEW_MS });
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

  await setCachedAccessToken({
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
  return await fetchWithTimeout(flavor.quotaUrl, {
    request: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...flavor.quotaHeaders(),
      },
      body: JSON.stringify({ project: projectId }),
    },
    timeoutMs: timeoutMs ?? QUOTA_TIMEOUT_MS,
    consume: async (response) => {
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`${flavor.name} quota auth error: ${response.status}`);
        }
        throw new Error(`${flavor.name} quota API error: ${response.status}`);
      }
      return (await response.json()) as Response;
    },
  });
}

/** Retries once with a fresh token when the quota API rejects the token. */
async function fetchAccountBuckets<Key extends GoogleAuthSourceKey, Response, Bucket>(params: {
  flavor: GoogleQuotaFlavor<Key, Response, Bucket>;
  account: GoogleAccount<Key>;
  credentials: GoogleCompanionConfiguredCredentials;
  timeoutMs: number | undefined;
}): Promise<{ buckets: Bucket[] } | { error: string }> {
  const { flavor, account, credentials, timeoutMs } = params;
  try {
    const token = await getAccessToken({ account, credentials, timeoutMs, force: false });
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
      if (!(err instanceof Error && err.message.includes("auth error"))) throw err;
      const retryToken = await getAccessToken({ account, credentials, timeoutMs, force: true });
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
    if (err instanceof Error && err.message.includes("timeout")) return { error: "API timeout" };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The quota of the account of one login (`authData` holds that one login); null when the login
 * has no usable account.
 */
export async function queryGoogleQuota<Key extends GoogleAuthSourceKey, Response, Bucket>(
  flavor: GoogleQuotaFlavor<Key, Response, Bucket>,
  options: { requestTimeoutMs?: number; authData: AuthData },
): Promise<GoogleQuotaResult<Bucket>> {
  const configuredProjectId = await resolveGoogleConfiguredProjectId(flavor);
  const [account] = resolveGoogleAccounts(flavor, options.authData, configuredProjectId);
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
  if ("error" in result) return { success: false, error: result.error || noData };
  if (result.buckets.length === 0) return { success: false, error: noData };
  return { success: true, buckets: result.buckets };
}
