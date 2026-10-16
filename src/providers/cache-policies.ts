/**
 * The cache policies several providers share. Each provider names its own policy
 * (`cachePolicy` in `src/providers/<vendor>.ts`).
 */

import { API_KEY_VENDORS, type ApiKeyLoginSpec, readVendorKeys } from "../lib/api-key-resolver.js";
import type { QuotaProviderCachePolicy } from "../lib/entries.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";
import { deriveResolvedAuthIdentity, loginListIdentity } from "../lib/resolved-auth-identity.js";

type ResolvedCredential = {
  credential: string;
  principalKind?: "stable-id" | "credential";
  qualifiers?: readonly string[];
};

/** The identity of the one credential `resolve` finds; none when it finds none. */
export function resolvedCredentialPolicy(
  providerId: CanonicalQuotaProviderId,
  resolve: () => Promise<ResolvedCredential | null>,
): QuotaProviderCachePolicy {
  return {
    kind: "resolved-auth",
    async resolveIdentity() {
      const resolved = await resolve();
      if (!resolved) return null;
      return deriveResolvedAuthIdentity({
        providerId,
        principal: {
          kind: resolved.principalKind ?? "credential",
          value: resolved.credential,
        },
        qualifiers: resolved.qualifiers,
      });
    },
  };
}

/**
 * Every key the vendor checks: the env or config key with where it was found, else each stored
 * key login. A key bound to one regional `endpoint` has the endpoint in its identity.
 */
export function vendorKeysPolicy(
  providerId: CanonicalQuotaProviderId & keyof typeof API_KEY_VENDORS,
  endpoint?: string,
): QuotaProviderCachePolicy {
  const spec: ApiKeyLoginSpec = API_KEY_VENDORS[providerId];
  const keyIdentity = (key: string, source?: string) =>
    deriveResolvedAuthIdentity({
      providerId,
      principal: { kind: "credential", value: key },
      qualifiers: [...(endpoint ? [endpoint] : []), ...(source ? [source] : [])],
    });
  return {
    kind: "resolved-auth",
    async resolveIdentity() {
      const keys = await readVendorKeys(spec);
      if (keys.envOrConfig) return keyIdentity(keys.envOrConfig.key, keys.envOrConfig.source);
      return loginListIdentity(
        providerId,
        await Promise.all(
          keys.logins.map(async ({ row, auth }) => ({
            row,
            identity: auth.state === "configured" ? await keyIdentity(auth.apiKey) : null,
          })),
        ),
      );
    },
  };
}
