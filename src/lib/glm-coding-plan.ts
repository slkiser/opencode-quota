import type { InvalidAwareAuthResult } from "./api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import type { ZaiQuotaLimit, ZaiQuotaResult, ZaiResult } from "./types.js";

type GlmEnvelope = {
  code?: unknown;
  msg?: unknown;
  success?: unknown;
  data?: { limits?: unknown } | null;
  limits?: unknown;
};

type GlmCodingPlanDescriptor = {
  label: string;
  endpoint: string;
  httpErrorPrefix: string;
  resolveAuth: () => Promise<InvalidAwareAuthResult>;
} & ({ envelope: "zai"; apiErrorPrefix: string } | { envelope: "zhipu" });

export async function queryGlmCodingPlanQuota(
  descriptor: GlmCodingPlanDescriptor,
  options: { requestTimeoutMs?: number; apiKey?: string } = {},
): Promise<ZaiResult> {
  const auth = options.apiKey
    ? { state: "configured" as const, apiKey: options.apiKey }
    : await descriptor.resolveAuth();
  if (auth.state === "none") return null;
  if (auth.state === "invalid") return { success: false, error: auth.error };

  try {
    return await fetchWithTimeout(descriptor.endpoint, {
      request: {
        headers: {
          Authorization: auth.apiKey,
          "User-Agent": "OpenCode-Quota-Toast/1.0",
          "Content-Type": "application/json",
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const body = sanitizeDisplaySnippet(await response.text(), 120);
          return {
            success: false,
            error: `${descriptor.httpErrorPrefix} ${response.status}: ${body}`,
          };
        }

        const body = (await response.json()) as GlmEnvelope;
        if (
          descriptor.envelope === "zai" &&
          (body.success === false || (typeof body.code === "number" && body.code >= 400))
        ) {
          const message = typeof body.msg === "string" ? sanitizeDisplayText(body.msg) : "";
          return {
            success: false,
            error:
              message ||
              (typeof body.code === "number"
                ? `${descriptor.apiErrorPrefix} ${body.code}`
                : descriptor.apiErrorPrefix),
          };
        }

        const limits =
          descriptor.envelope === "zai" ? (body.data?.limits ?? body.limits) : body.data?.limits;
        if (!Array.isArray(limits)) return { success: false, error: "Invalid quota data" };

        const windows: ZaiQuotaResult["windows"] = {};
        for (const limit of limits as ZaiQuotaLimit[]) {
          const resetDate = limit.nextResetTime ? new Date(Math.round(limit.nextResetTime)) : null;
          const resetTimeIso =
            resetDate && Number.isFinite(resetDate.valueOf()) && resetDate.valueOf() > 0
              ? resetDate.toISOString()
              : undefined;
          const window = { percentRemaining: clampPercent(100 - limit.percentage), resetTimeIso };

          const isQuotaWindow =
            limit.type === "TOKENS_LIMIT" ||
            (descriptor.envelope === "zai" && limit.type === "CREDIT_LIMIT");
          if (isQuotaWindow && limit.unit === 3) windows.fiveHour = window;
          else if (isQuotaWindow && limit.unit === 6) windows.weekly = window;
          else if (limit.type === "TIME_LIMIT") windows.mcp = window;
        }

        return { success: true, label: descriptor.label, windows };
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    };
  }
}
