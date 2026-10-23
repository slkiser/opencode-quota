/**
 * Template target: src/providers/<provider>.ts
 *
 * The whole provider in one module: it asks the vendor's API and turns the reply into the row
 * contract (`src/providers/contract.ts`). Its label, OpenCode ids, row keys and where its API key
 * lives are its entry in `src/lib/provider-registration.ts`.
 */

import { API_KEY_VENDORS, hasVendorKey, readVendorKeys } from "../lib/api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { fetchWithTimeout } from "../lib/http.js";
import { finiteNumber, nonEmptyString } from "../lib/json-guards.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  type FetchError,
  fetchKeyLogins,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
} from "./contract.js";
import { vendorKeyDetails } from "./result-helpers.js";

const NAME = "Example Provider";
const SPEC = API_KEY_VENDORS["example-provider"];
const USAGE_URL = "https://api.example.com/v1/usage";

function failed(message: string): { rows: ProviderRow[]; errors: FetchError[] } {
  return { rows: [], errors: [{ message }] };
}

/** One key's rows, or its error. */
async function queryExampleRows(apiKey: string, requestTimeoutMs?: number) {
  try {
    return await fetchWithTimeout(USAGE_URL, {
      request: { headers: { Authorization: `Bearer ${apiKey}` } },
      timeoutMs: requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const body = sanitizeDisplaySnippet(await response.text(), 120);
          return failed(`${NAME} API error ${response.status}: ${body}`);
        }
        const usage = (await response.json()) as { used_percent?: unknown; resets_at?: unknown };
        const usedPercent = finiteNumber(usage?.used_percent);
        if (usedPercent === undefined) return failed(`${NAME} returned no usage`);

        // Row id `example-provider.monthly`: users' hide, rename and order settings use it.
        const row = quotaRow({
          ...MONTHLY,
          percentRemaining: 100 - usedPercent,
          resetsAt: nonEmptyString(usage.resets_at),
        });
        return { rows: [row], errors: [] };
      },
    });
  } catch (error) {
    return failed(sanitizeDisplayText(error instanceof Error ? error.message : String(error)));
  }
}

export const exampleProviderProvider: QuotaProvider = {
  id: "example-provider",
  // Tells the keys apart, so the cache never shows one key's rows for another.
  cachePolicy: vendorKeysPolicy("example-provider"),

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "example-provider",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return hasVendorKey(await readVendorKeys(SPEC));
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["example-provider", "example"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const keys = await readVendorKeys(SPEC);
    // Where the key came from, for /quota_status. Never the key itself.
    const debug = vendorKeyDetails(SPEC, keys);
    const query = (apiKey: string) => queryExampleRows(apiKey, ctx.config?.requestTimeoutMs);

    // An env or config key is used alone; else each key stored in OpenCode is its own account.
    if (keys.envOrConfig) {
      const { rows, errors } = await query(keys.envOrConfig.key);
      return { attempted: true, accounts: [{ name: NAME, rows, errors }], debug };
    }
    const accounts = await fetchKeyLogins({
      providerName: NAME,
      logins: keys.logins,
      brokenFirst: false,
      fetchLogin: ({ auth }) => query(auth.apiKey),
    });
    return { attempted: keys.logins.length > 0, accounts, debug };
  },
};
