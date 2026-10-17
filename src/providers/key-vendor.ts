/**
 * API-key vendors: each check reads the vendor's one key list (`readVendorKeys`), and whether
 * the vendor shows, its stored-login accounts and its key status details all come from it.
 */

import { hasVendorKey, type VendorKeys } from "../lib/api-key-resolver.js";
import type { QuotaProviderContext } from "../lib/entries.js";
import type { CredentialRow } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";
import { type AccountResult, failedAccount, fetchEachLogin, type LoginFetch } from "./contract.js";

/**
 * When a key vendor shows: `key` with a key alone; `listed-or-key` when OpenCode lists the
 * vendor or a key is set; `listed-and-key` only when OpenCode lists it and a key is set.
 */
export type KeyVendorAvailability = "key" | "listed-or-key" | "listed-and-key";

export async function isKeyVendorAvailable(params: {
  ctx: QuotaProviderContext;
  providerId: CanonicalQuotaProviderId;
  availability: KeyVendorAvailability;
  readKeys: () => Promise<VendorKeys>;
  /** Whether OpenCode lists the vendor; by default, its own provider id. */
  isListed?: () => Promise<boolean>;
}): Promise<boolean> {
  if (params.availability === "key") return hasVendorKey(await params.readKeys());
  const listed = await (params.isListed?.() ??
    isCanonicalProviderAvailable({
      ctx: params.ctx,
      providerId: params.providerId,
      fallbackOnError: false,
    }));
  if (params.availability === "listed-or-key" && listed) return true;
  if (params.availability === "listed-and-key" && !listed) return false;
  return hasVendorKey(await params.readKeys());
}

/**
 * Each stored key login as its own account (a broken login as its error; `brokenFirst` lists
 * those before the fetched ones), or the broken first login as the vendor's one error. Not
 * attempted without either. The env or config key is the vendor's own to fetch.
 */
export async function fetchStoredKeys(params: {
  providerName: string;
  keys: VendorKeys;
  brokenFirst: boolean;
  fetchKey: (apiKey: string, row: CredentialRow) => Promise<LoginFetch>;
}): Promise<{ attempted: boolean; accounts: AccountResult[] }> {
  const { keys } = params;
  if (keys.logins.length === 0) {
    return keys.broken === null
      ? { attempted: false, accounts: [] }
      : { attempted: true, accounts: [failedAccount(params.providerName, keys.broken)] };
  }

  const accounts = await fetchEachLogin({
    providerName: params.providerName,
    logins: keys.logins,
    async fetchLogin({ row, auth }) {
      if (auth.state === "invalid") return { rows: [], errors: [{ message: auth.error }] };
      return params.fetchKey(auth.apiKey, row);
    },
  });
  if (!params.brokenFirst) return { attempted: true, accounts };
  const broken = new Set(
    keys.logins.filter(({ auth }) => auth.state === "invalid").map(({ row }) => row.id),
  );
  return {
    attempted: true,
    accounts: [
      ...accounts.filter((account) => broken.has(account.login ?? "")),
      ...accounts.filter((account) => !broken.has(account.login ?? "")),
    ],
  };
}
