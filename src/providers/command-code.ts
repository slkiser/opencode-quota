/** Command Code GOAT: the five-hour and weekly limits for each API-key login. */
import { API_KEY_VENDORS, readVendorKeys } from "../lib/api-key-resolver.js";
import { sanitizeDisplaySnippet } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { clampPercent } from "../lib/format-utils.js";
import {
  errorWords,
  failureFacts,
  requestJson,
  RequestFailedError,
  thrownFacts,
} from "../lib/http.js";
import { finiteNumber, isRecord, nonEmptyString } from "../lib/json-guards.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import { fetchError, FIVE_HOUR, type LoginFetch, quotaRow, WEEKLY } from "./contract.js";
import { fetchStoredKeys, isKeyVendorAvailable } from "./key-vendor.js";
import { vendorKeyDetails } from "./result-helpers.js";

const LABEL = "Command Code";
const SPEC = API_KEY_VENDORS.commandcode;
const API_BASE = "https://api.commandcode.ai/alpha";

async function queryCommandCode(
  apiKey: string,
  timeoutMs?: number,
): Promise<NonNullable<LoginFetch>> {
  async function get(path: string): Promise<unknown> {
    const reply = await requestJson(`${API_BASE}/${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      secrets: [apiKey],
      timeoutMs,
    });
    if (reply.ok) return reply.json;
    const { failure } = reply;
    const authError = failure.status === 401 || failure.status === 403;
    throw new RequestFailedError(
      failure.kind === "http"
        ? `${LABEL} API error ${failure.status}${errorWords(sanitizeDisplaySnippet(failure.detail, 120))}`
        : failure.detail,
      failureFacts(failure, authError ? "login_expired" : failure.code),
    );
  }

  try {
    const identity = await get("whoami?limits=1");
    if (!isRecord(identity) || identity.success !== true) {
      throw new Error("Command Code whoami returned an unexpected response shape");
    }
    const orgId = isRecord(identity.org) ? nonEmptyString(identity.org.id) : undefined;
    if (identity.org !== null && !orgId) {
      throw new Error("Command Code whoami returned an invalid org");
    }
    const query = orgId ? `?${new URLSearchParams({ orgId })}` : "";
    const credits = await get(`billing/credits${query}`);
    if (!isRecord(credits) || !isRecord(credits.windowLimits)) {
      throw new Error("Command Code credits returned an unexpected response shape");
    }
    const rows = [];
    for (const [field, slot] of [
      ["fiveHour", FIVE_HOUR],
      ["weekly", WEEKLY],
    ] as const) {
      const value = credits.windowLimits[field];
      if (value === undefined || value === null) continue;
      if (!isRecord(value)) throw new Error(`Command Code ${field} returned an invalid window`);
      if (value.cap === undefined || value.cap === null || value.cap === 0) continue;
      const cap = finiteNumber(value.cap);
      const used = finiteNumber(value.used);
      const resetAt = finiteNumber(value.resetAt);
      if (
        cap === undefined ||
        cap < 0 ||
        used === undefined ||
        used < 0 ||
        resetAt === undefined ||
        !Number.isFinite(new Date(resetAt).getTime())
      ) {
        throw new Error(`Command Code ${field} returned an invalid window`);
      }
      rows.push(
        quotaRow({
          ...slot,
          percentRemaining: clampPercent(((cap - used) / cap) * 100),
          resetsAt: new Date(resetAt).toISOString(),
        }),
      );
    }
    return { rows, errors: [] };
  } catch (error) {
    return {
      rows: [],
      errors: [
        fetchError(
          error instanceof Error ? error.message : "Command Code returned an unexpected response",
          thrownFacts(error) ?? { code: "bad_response" },
        ),
      ],
    };
  }
}

export const commandCodeProvider: QuotaProvider = {
  id: "commandcode",
  cachePolicy: vendorKeysPolicy("commandcode"),

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    return isKeyVendorAvailable({
      ctx,
      providerId: "commandcode",
      availability: "key",
      readKeys: () => readVendorKeys(SPEC, ctx.locationDirectory),
    });
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "commandcode");
  },

  async fetch(ctx) {
    const keys = await readVendorKeys(SPEC, ctx.locationDirectory);
    const debug = vendorKeyDetails(SPEC, keys, ctx.locationDirectory);
    const query = (key: string) => queryCommandCode(key, ctx.config?.requestTimeoutMs);
    if (keys.envOrConfig) {
      return {
        attempted: true,
        accounts: [{ name: LABEL, ...(await query(keys.envOrConfig.key)) }],
        debug,
      };
    }
    return {
      ...(await fetchStoredKeys({
        providerName: LABEL,
        keys,
        brokenFirst: true,
        fetchKey: query,
      })),
      debug,
    };
  },
};
