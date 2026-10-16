import type { Amount } from "../core/types.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProviderCachePolicy, QuotaProviderContext } from "../lib/entries.js";
import {
  type GoogleAuthSourceKey,
  type GoogleQuotaFlavor,
  googleLoginsIdentity,
  hasGoogleQuotaRuntimeAvailable,
  inspectGoogleAuthPresence,
  queryGoogleQuota,
  readGoogleLogins,
} from "../lib/google-oauth-quota.js";
import { credentialRowAuthData } from "../lib/opencode-auth.js";
import { fetchEachLogin, type ProviderFetchResult, type ProviderRow } from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

/** The parts in which the Google AGY and Gemini CLI providers differ. */
export type GoogleProviderFlavor<Key extends GoogleAuthSourceKey, Response, Bucket> = {
  quota: GoogleQuotaFlavor<Key, Response, Bucket>;
  /** Error for a login OpenCode could not return; without it the login is queried. */
  failedLoginError?: (resolveError: string) => string;
  compareBuckets?: (left: Bucket, right: Bucket) => number;
  /** The row of one bucket, or none when the bucket gives no row key. */
  row: (bucket: Bucket) => ProviderRow | undefined;
};

/** Set up when a login OpenCode uses has an account and the companion plugin is installed. */
export async function isGoogleProviderAvailable<Key extends GoogleAuthSourceKey, Response, Bucket>(
  flavor: GoogleProviderFlavor<Key, Response, Bucket>,
): Promise<boolean> {
  try {
    return await hasGoogleQuotaRuntimeAvailable(flavor.quota);
  } catch {
    return false;
  }
}

/** Who the provider is signed in as: its logins and the companion's OAuth client. */
export function googleCachePolicy<Key extends GoogleAuthSourceKey, Response, Bucket>(
  flavor: GoogleProviderFlavor<Key, Response, Bucket>,
): QuotaProviderCachePolicy {
  return {
    kind: "resolved-auth",
    resolveIdentity: async () =>
      googleLoginsIdentity(flavor.quota, await readGoogleLogins(flavor.quota)),
  };
}

/** A remaining count Google reported ("1200", "12.5") in `unit`; none for anything else. */
export function remainingCount(text: string | undefined, unit: string): Amount | undefined {
  const number = text?.trim();
  if (!number || !/^\d+(?:\.\d+)?$/u.test(number)) return undefined;
  const [integer = "0", fraction = ""] = number.split(".");
  const whole = integer.replace(/^0+(?=\d)/u, "");
  const decimals = fraction.replace(/0+$/u, "");
  return {
    decimal: decimals ? `${whole}.${decimals}` : whole,
    unit: { kind: "count", unit },
  };
}

/** One account per OpenCode login, named after the login. */
export async function fetchGoogleProviderQuota<Key extends GoogleAuthSourceKey, Response, Bucket>(
  flavor: GoogleProviderFlavor<Key, Response, Bucket>,
  ctx: QuotaProviderContext,
): Promise<ProviderFetchResult> {
  const { quota } = flavor;
  const [logins, companion] = await Promise.all([
    readGoogleLogins(quota),
    quota.companion.inspect(),
  ]);
  const auth = inspectGoogleAuthPresence(quota, logins);
  const debug = statusDetailsFromRecord({
    auth_state: auth.state,
    auth_source: auth.sourceKey ?? "(none)",
    account_count: String(auth.accountCount),
    valid_account_count: String(auth.validAccountCount),
    companion_package_state: companion.state,
    companion_package_path:
      companion.state === "missing" ? "(none)" : (companion.resolvedPath ?? "(none)"),
    auth_error: auth.state === "invalid" ? sanitizeDisplayText(auth.error) : undefined,
    companion_error:
      companion.state !== "present" ? sanitizeDisplayText(companion.error) : undefined,
  });

  const requestTimeoutMs = ctx.config?.requestTimeoutMsConfigured
    ? ctx.config.requestTimeoutMs
    : undefined;
  const accounts = await fetchEachLogin({
    providerName: quota.name,
    logins: logins.rows.map((row) => ({ row })),
    async fetchLogin({ row }) {
      const result =
        row.resolveError !== undefined && flavor.failedLoginError
          ? { success: false as const, error: flavor.failedLoginError(row.resolveError) }
          : await queryGoogleQuota(quota, {
              requestTimeoutMs,
              authData: credentialRowAuthData(row),
            });
      if (!result) return null;
      if (!result.success) return { rows: [], errors: [{ message: result.error }] };
      const buckets = flavor.compareBuckets
        ? [...result.buckets].sort(flavor.compareBuckets)
        : result.buckets;
      return { rows: buckets.flatMap((bucket) => flavor.row(bucket) ?? []), errors: [] };
    },
  });
  return { attempted: logins.rows.length > 0, accounts, debug };
}
