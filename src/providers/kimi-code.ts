import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryKimiQuota } from "../lib/kimi.js";
import {
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
  getKimiAuthDiagnostics,
  resolveKimiAuth,
  resolveKimiAuthCached,
} from "../lib/kimi-auth.js";
import { formatCredentialDisplayNames, readCredentialRows } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { AuthData } from "../lib/types.js";
import {
  apiKeyStatusDetails,
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  withStatusDetails,
} from "./result-helpers.js";

function formatUsageRight(window: { used: number; limit: number }): string {
  return `${window.used}/${window.limit}`;
}

export const kimiCodeProvider: QuotaProvider = {
  id: "kimi-for-coding",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "kimi-for-coding",
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    const auth = await resolveKimiAuthCached({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });
    return auth.state === "configured" || auth.state === "invalid";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "kimi-for-coding";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getKimiAuthDiagnostics({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });
    const authDetails = apiKeyStatusDetails(diagnostics);
    const auth = await resolveKimiAuthCached({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });

    if (auth.state === "none") {
      return withStatusDetails(notAttemptedResult(), authDetails);
    }

    if (diagnostics.source === "opencode.db") {
      const credentialRows = (await readCredentialRows()).filter((row) =>
        ["kimi-for-coding", "kimi-code", "kimi"].includes(row.integrationId),
      );
      const rowNames = formatCredentialDisplayNames(
        "Kimi Code",
        credentialRows.map((row) => ({ row, fallbackName: "Kimi Code" })),
      );
      const displayNamesByRowId = new Map(
        credentialRows.map((row, index) => [row.id, rowNames[index] ?? "Kimi Code"]),
      );
      const invalidErrors: QuotaProviderResult["errors"] = [];
      const credentials = credentialRows.flatMap((row) => {
        const rowAuth = resolveKimiAuth({ [row.integrationId]: row.value } as AuthData);
        if (rowAuth.state === "invalid") {
          invalidErrors.push({ label: displayNamesByRowId.get(row.id) ?? "Kimi Code", message: rowAuth.error });
        }
        return rowAuth.state === "configured" ? [{ row, auth: rowAuth }] : [];
      });
      if (credentials.length > 0 || invalidErrors.length > 0) {
        const results = await Promise.all(
          credentials.map(async ({ row, auth }) => ({
            row,
            result: await queryKimiQuota({
              requestTimeoutMs: ctx.config?.requestTimeoutMs,
              apiKey: auth.apiKey,
            }),
          })),
        );
        const entries: QuotaToastEntry[] = [];
        const errors: QuotaProviderResult["errors"] = [...invalidErrors];
        for (const { row, result } of results) {
          const group = displayNamesByRowId.get(row.id) ?? "Kimi Code";
          if (!result) continue;
          if (!result.success) {
            errors.push({ label: group, message: result.error });
            continue;
          }
          entries.push(
            ...result.windows.map((window) => ({
              accounting: {
                resultType: "quota" as const,
                acquisitionMethod: "remote_api" as const,
                ownership: "maintained" as const,
                authority: "provider_reported" as const,
                sourceId: row.id,
              },
              name: `${group} ${window.label}`,
              group,
              label: `${window.label}:`,
              right: formatUsageRight(window),
              percentRemaining: window.percentRemaining,
              resetTimeIso: window.resetTimeIso,
            })),
          );
        }
        return withStatusDetails(attemptedResult(entries, errors), authDetails);
      }
    }

    if (auth.state === "invalid") {
      return withStatusDetails(attemptedErrorResult("Kimi Code", auth.error), authDetails);
    }

    const result = await queryKimiQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    if (!result) {
      return withStatusDetails(notAttemptedResult(), [
        ...authDetails,
        { key: "live_fetch_error", value: "Kimi API key became unavailable before fetch" },
      ]);
    }

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult("Kimi Code", result.error), [
        ...authDetails,
        { key: "live_fetch_error", value: result.error },
      ]);
    }

    const entries: QuotaToastEntry[] = result.windows.map((window) => ({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: `${result.label} ${window.label}`,
      group: result.label,
      label: `${window.label}:`,
      right: formatUsageRight(window),
      percentRemaining: window.percentRemaining,
      resetTimeIso: window.resetTimeIso,
    }));

    return withStatusDetails(
      attemptedResult(entries, [], {
        singleWindowDisplayName: result.label,
      }),
      [
        ...authDetails,
        ...result.windows.map((window) => ({
          key: window.label.toLowerCase().replace(/\s+/g, "_"),
          value: `used=${window.used}/${window.limit} percent_remaining=${window.percentRemaining} reset_at=${window.resetTimeIso ?? "(none)"}`,
        })),
        ...(result.windows.length === 0
          ? [{ key: "live_state", value: "no reportable Kimi quota" }]
          : []),
      ],
    );
  },
};
