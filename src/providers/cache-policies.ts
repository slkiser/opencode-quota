/**
 * The cache policies several providers share. Each provider names its own policy
 * (`cachePolicy` in `src/providers/<vendor>.ts`).
 */

import {
  API_KEY_VENDORS,
  type ApiKeyLoginSpec,
  readVendorKeys,
  type VendorKeys,
} from "../lib/api-key-resolver.js";
import type { QuotaProviderCachePolicy, QuotaProviderContext } from "../lib/entries.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";
import {
  deriveResolvedAuthIdentity,
  loginListIdentity,
  type ResolvedAuthIdentity,
} from "../lib/resolved-auth-identity.js";

export type ResolvedCredential = {
  credential: string;
  principalKind?: "stable-id" | "credential";
  qualifiers?: readonly string[];
};

/** The identity of the one credential `resolve` finds; none when it finds none. */
export function resolvedCredentialPolicy(
  providerId: CanonicalQuotaProviderId,
  resolve: (ctx: QuotaProviderContext) => Promise<ResolvedCredential | null>,
): QuotaProviderCachePolicy {
  return {
    kind: "resolved-auth",
    async resolveIdentity(ctx) {
      const resolved = await resolve(ctx);
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
 * Who the vendor's keys are: the env or config key with where it was found, else each stored key
 * login. A key bound to one regional `endpoint` has the endpoint in its identity. Null without a
 * key, or when a login can't be told apart safely.
 */
export async function vendorKeysIdentity(
  providerId: CanonicalQuotaProviderId,
  keys: VendorKeys,
  endpoint?: string,
): Promise<ResolvedAuthIdentity | null> {
  const keyIdentity = (key: string, source?: string) =>
    deriveResolvedAuthIdentity({
      providerId,
      principal: { kind: "credential", value: key },
      qualifiers: [...(endpoint ? [endpoint] : []), ...(source ? [source] : [])],
    });
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
}

/** Every key the vendor checks; see `vendorKeysIdentity`. */
export function vendorKeysPolicy(
  providerId: CanonicalQuotaProviderId & keyof typeof API_KEY_VENDORS,
  endpoint?: string,
): QuotaProviderCachePolicy {
  const spec: ApiKeyLoginSpec = API_KEY_VENDORS[providerId];
  return {
    kind: "resolved-auth",
    async resolveIdentity(ctx) {
      const keys = await readVendorKeys(spec, ctx.locationDirectory);
      return await vendorKeysIdentity(providerId, keys, endpoint);
    },
  };
}
