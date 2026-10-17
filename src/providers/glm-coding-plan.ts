/**
 * Z.ai and Zhipu: one GLM coding plan fetcher with two endpoints. Each key stored in OpenCode
 * is queried as its own account; without stored keys, the key the resolver finds is.
 */

import { API_KEY_VENDORS, type ApiKeyLoginSpec, readVendorKeys } from "../lib/api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { clampPercent } from "../lib/format-utils.js";
import { failureFacts, requestJson } from "../lib/http.js";
import type { QuotaError } from "../lib/types.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  FIVE_HOUR,
  failedAccount,
  fetchError,
  type ProviderFetchResult,
  type ProviderRow,
  WEEKLY,
  windowRows,
} from "./contract.js";
import { fetchStoredKeys, isKeyVendorAvailable } from "./key-vendor.js";
import { statusDetailsFromRecord, vendorKeyDetails } from "./result-helpers.js";

/** One GLM coding plan endpoint: Z.ai (global) or Zhipu (China). */
type GlmEndpoint = {
  label: string;
  url: string;
  auth: ApiKeyLoginSpec;
  /** Z.ai also reports errors in a 200 reply and may put `limits` at the top level. */
  envelope: "zai" | "zhipu";
};

const GLM_ENDPOINTS: Readonly<Record<"zai" | "zhipu", GlmEndpoint>> = {
  zai: {
    label: "Z.ai",
    url: "https://api.z.ai/api/monitor/usage/quota/limit",
    auth: API_KEY_VENDORS.zai,
    envelope: "zai",
  },
  zhipu: {
    label: "Zhipu",
    url: "https://bigmodel.cn/api/monitor/usage/quota/limit",
    auth: API_KEY_VENDORS.zhipu,
    envelope: "zhipu",
  },
};

type GlmEnvelope = {
  code?: unknown;
  msg?: unknown;
  success?: unknown;
  data?: { limits?: unknown } | null;
  limits?: unknown;
};

/** One entry of the reply's `limits`: unit 3 is the 5h window, unit 6 the week. */
type GlmLimit = {
  type: string;
  unit: number;
  usage: number;
  currentValue?: number;
  percentage: number;
  nextResetTime?: number;
};

type GlmWindow = { percentRemaining: number; resetTimeIso?: string };

/** One key's rows, or the error to show. */
type GlmReply = { success: true; rows: ProviderRow[] } | QuotaError;

const MCP = { key: "mcp", label: "MCP", window: "mcp" } as const;

/**
 * The percent left: from exact credit values when a credit limit has them, else reported. The
 * reported one is read first, so a malformed `percentage` fails the reply either way.
 */
function percentRemaining(limit: GlmLimit): number {
  const reported = clampPercent(100 - limit.percentage);
  if (
    limit.type === "CREDIT_LIMIT" &&
    typeof limit.usage === "number" &&
    Number.isFinite(limit.usage) &&
    limit.usage > 0 &&
    typeof limit.currentValue === "number" &&
    Number.isFinite(limit.currentValue) &&
    limit.currentValue >= 0
  ) {
    return clampPercent(((limit.usage - limit.currentValue) / limit.usage) * 100);
  }
  return reported;
}

/** The 5h, weekly and MCP rows of the reply's limits; a later limit of a window wins. */
function glmRows(limits: GlmLimit[]): ProviderRow[] {
  const windows: { fiveHour?: GlmWindow; weekly?: GlmWindow; mcp?: GlmWindow } = {};
  for (const limit of limits) {
    const resetDate = limit.nextResetTime ? new Date(Math.round(limit.nextResetTime)) : null;
    const resetTimeIso =
      resetDate && Number.isFinite(resetDate.valueOf()) && resetDate.valueOf() > 0
        ? resetDate.toISOString()
        : undefined;
    const window = { percentRemaining: percentRemaining(limit), resetTimeIso };

    const isQuotaWindow = limit.type === "TOKENS_LIMIT" || limit.type === "CREDIT_LIMIT";
    if (isQuotaWindow && limit.unit === 3) windows.fiveHour = window;
    else if (isQuotaWindow && limit.unit === 6) windows.weekly = window;
    else if (limit.type === "TIME_LIMIT") windows.mcp = window;
  }
  return windowRows([
    { slot: FIVE_HOUR, value: windows.fiveHour },
    { slot: WEEKLY, value: windows.weekly },
    { slot: MCP, value: windows.mcp },
  ]);
}

async function queryGlmRows(
  endpoint: GlmEndpoint,
  apiKey: string,
  requestTimeoutMs?: number,
): Promise<GlmReply> {
  const apiError = `${endpoint.label} API error`;
  const reply = await requestJson(endpoint.url, {
    headers: {
      Authorization: apiKey,
      "User-Agent": "OpenCode-Quota-Toast/1.0",
      "Content-Type": "application/json",
    },
    secrets: [apiKey],
    timeoutMs: requestTimeoutMs,
  });
  if (!reply.ok) {
    const { failure } = reply;
    return {
      success: false,
      error:
        failure.kind === "http"
          ? `${apiError} ${failure.status}: ${sanitizeDisplaySnippet(failure.detail, 120)}`
          : failure.detail,
      facts: failureFacts(failure),
    };
  }

  try {
    const body = reply.json as GlmEnvelope;
    if (
      endpoint.envelope === "zai" &&
      (body.success === false || (typeof body.code === "number" && body.code >= 400))
    ) {
      const message = typeof body.msg === "string" ? sanitizeDisplayText(body.msg) : "";
      const fallback = typeof body.code === "number" ? `${apiError} ${body.code}` : apiError;
      return { success: false, error: message || fallback };
    }

    const limits =
      endpoint.envelope === "zai" ? (body.data?.limits ?? body.limits) : body.data?.limits;
    if (!Array.isArray(limits)) return { success: false, error: "Invalid quota data" };
    return { success: true, rows: glmRows(limits as GlmLimit[]) };
  } catch (error) {
    return {
      success: false,
      error: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** The debug line of a window row: `80% reset_at=…`. */
function formatWindow(rows: readonly ProviderRow[], key: string): string | undefined {
  const row = rows.find((candidate) => candidate.key === key);
  return row ? `${row.percentRemaining}% reset_at=${row.resetsAt ?? "(none)"}` : undefined;
}

async function fetchGlmQuota(
  endpoint: GlmEndpoint,
  ctx: QuotaProviderContext,
): Promise<ProviderFetchResult> {
  const requestTimeoutMs = ctx.config?.requestTimeoutMs;
  const keys = await readVendorKeys(endpoint.auth);
  const authDetails = vendorKeyDetails(endpoint.auth, keys);
  if (!keys.envOrConfig) {
    const stored = await fetchStoredKeys({
      providerName: endpoint.label,
      keys,
      brokenFirst: false,
      async fetchKey(apiKey) {
        const result = await queryGlmRows(endpoint, apiKey, requestTimeoutMs);
        if (!result.success) return { rows: [], errors: [fetchError(result.error, result.facts)] };
        return { rows: result.rows, errors: [] };
      },
    });
    return { ...stored, debug: authDetails };
  }

  const result = await queryGlmRows(endpoint, keys.envOrConfig.key, requestTimeoutMs);
  const rows = result.success ? result.rows : [];
  const debug = [
    ...authDetails,
    ...statusDetailsFromRecord({
      live_fetch_error: result.success ? undefined : result.error,
      five_hour_remaining: formatWindow(rows, FIVE_HOUR.key),
      weekly_remaining: formatWindow(rows, WEEKLY.key),
      mcp_remaining: formatWindow(rows, MCP.key),
      live_state:
        result.success && rows.length === 0
          ? `no reportable ${endpoint.label} quota windows`
          : undefined,
    }),
  ];
  if (!result.success) {
    return {
      attempted: true,
      accounts: [failedAccount(endpoint.label, result.error, result.facts)],
      debug,
    };
  }
  return { attempted: true, accounts: [{ name: endpoint.label, rows, errors: [] }], debug };
}

function glmProvider(
  id: "zai" | "zhipu",
  matchesCurrentModel: (model: string) => boolean,
): QuotaProvider {
  const endpoint = GLM_ENDPOINTS[id];
  return {
    id,
    cachePolicy: vendorKeysPolicy(id),

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      return await isKeyVendorAvailable({
        ctx,
        providerId: id,
        availability: "listed-and-key",
        readKeys: () => readVendorKeys(endpoint.auth),
      });
    },

    matchesCurrentModel,

    fetch: (ctx: QuotaProviderContext) => fetchGlmQuota(endpoint, ctx),
  };
}

export const zaiProvider = glmProvider("zai", (model) => {
  const lower = model.toLowerCase();
  const provider = lower.split("/")[0] ?? "";
  return provider.includes("zai") || lower.includes("glm");
});

export const zhipuProvider = glmProvider("zhipu", (model) => {
  const provider = model.toLowerCase().split("/")[0] ?? "";
  return provider.includes("zhipu") || provider === "glm-coding-plan";
});
