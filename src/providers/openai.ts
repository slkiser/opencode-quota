/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
  resolveOpenAIOAuth,
} from "../lib/openai.js";
import { formatCredentialDisplayNames, readCredentialRows } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import type { AuthData } from "../lib/types.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

export const openaiProvider: QuotaProvider = {
  id: "openai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "openai",
      fallbackOnError: true,
    });

    if (availableByProviderId) {
      return true;
    }

    return hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const rows = (await readCredentialRows()).filter((row) =>
      ["openai", "codex", "chatgpt", "opencode"].includes(row.integrationId),
    );
    const credentials = rows.flatMap((row) => {
      const auth = resolveOpenAIOAuth({ [row.integrationId]: row.value } as AuthData);
      return auth.state === "configured" ? [{ row, auth }] : [];
    });
    const entries: QuotaProviderResult["entries"] = [];
    const errors: QuotaProviderResult["errors"] = [];
    const mapResult = (
      result: Awaited<ReturnType<typeof queryOpenAIQuota>>,
      options: { group?: string; sourceId?: string } = {},
    ) =>
      mapNullableProviderResult(result, {
        errorLabel: options.group ?? "OpenAI",
        onSuccess: (result) => {
          const group = options.group ?? result.label;
          return attemptedResult(
            groupedPercentWindowEntries({
              group,
              accounting: {
                resultType: "rate_limit",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
                ...(options.sourceId ? { sourceId: options.sourceId } : {}),
              },
              windows: [
                { window: result.windows.hourly, suffix: "5h", label: "5h:" },
                { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
                { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
                { window: result.windows.codeReview, suffix: "Code Review", label: "Code Review:" },
              ],
            }),
            [],
            { singleWindowDisplayName: group },
          );
        },
      });
    const results = await Promise.all(
      credentials.map(async ({ row, auth }) => ({
        row,
        auth,
        result: await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs, auth }),
      })),
    );
    const names = formatCredentialDisplayNames(
      "OpenAI",
      results.map(({ row, result }) => ({
        row,
        fallbackName: result?.success ? result.label : "OpenAI",
      })),
    );

    for (const [index, { row, result }] of results.entries()) {
      const providerResult = mapResult(result, { group: names[index], sourceId: row.id });
      entries.push(...providerResult.entries);
      errors.push(...providerResult.errors);
    }
    const providerResult =
      entries.length > 0 || errors.length > 0
        ? attemptedResult(entries, errors)
        : mapResult(await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs }));
    const configuredAuth = credentials[0]?.auth;
    const configured = configuredAuth !== undefined;
    const expiresAt = configuredAuth?.expiresAt;
    return withStatusDetails(
      providerResult,
      statusDetailsFromRecord({
        auth_configured: configured ? "true" : "false",
        auth_source: configuredAuth?.sourceKey ?? "(none)",
        token_status: !configured
          ? "(none)"
          : expiresAt && expiresAt < Date.now()
            ? "expired"
            : "valid",
        token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : "(none)",
        account_email: configuredAuth?.email ? sanitizeDisplayText(configuredAuth.email) : "(none)",
        account_id: configuredAuth?.accountId
          ? sanitizeDisplayText(configuredAuth.accountId)
          : "(none)",
      }),
    );
  },
};
