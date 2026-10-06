/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  OPENAI_AUTH_SOURCE_KEYS,
  queryOpenAIQuota,
  resolveOpenAIOAuth,
} from "../lib/openai.js";
import {
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
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

    if (await hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS })) {
      return true;
    }

    // Without an OpenAI alias or OAuth login, a stored API key still counts.
    const keyRows = await readCredentialRows(OPENAI_AUTH_SOURCE_KEYS, {
      methods: ["key"],
      firstOnly: true,
    });
    return keyRows.length > 0;
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const currentIntegrationId =
      ctx.config?.currentProviderID ??
      resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config?.currentModel ?? "" })
        ?.providerId;
    const rows = (await readCredentialRows(OPENAI_AUTH_SOURCE_KEYS, { methods: ["oauth", "key"] }))
      .filter((row) => (OPENAI_AUTH_SOURCE_KEYS as readonly string[]).includes(row.integrationId))
      // Active is per integration: keep the session's active login first, then
      // other active logins, preserving source order within each set. Without
      // the session's login, an active OAuth login (which has quota numbers)
      // goes before an active API key (which only has a status).
      .sort((left, right) => {
        const activeOrder = Number(right.active) - Number(left.active);
        if (activeOrder !== 0 || !left.active) return activeOrder;
        const sessionOrder =
          Number(right.integrationId === currentIntegrationId) -
          Number(left.integrationId === currentIntegrationId);
        if (sessionOrder !== 0) return sessionOrder;
        return Number(left.value.type === "api") - Number(right.value.type === "api");
      });
    // A failed login stays in the list so it shows as its own error row.
    const credentials = rows.flatMap((row) => {
      if (row.value.type === "api") return [];
      const auth = resolveOpenAIOAuth({
        [row.integrationId]: credentialRowAuthEntry(row),
      } as AuthData);
      return auth.state === "none" ? [] : [{ row, auth }];
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
        result: await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs, auth }),
      })),
    );
    const resultByRow = new Map(results.map(({ row, result }) => [row, result]));
    // Names span every stored account (OAuth and API key) so numbering and the
    // `(active)` marker match the accounts OpenCode actually holds.
    const names = formatCredentialDisplayNames(
      "OpenAI",
      rows.map((row) => {
        const result = resultByRow.get(row);
        return {
          row,
          fallbackName: result?.success ? result.label : "OpenAI",
          numberUnnamed: row.value.type === "api",
        };
      }),
    );
    const nameByRow = new Map(rows.map((row, index) => [row, names[index]]));

    for (const row of rows) {
      const name = nameByRow.get(row) ?? "OpenAI";
      if (row.value.type !== "api") {
        const providerResult = mapResult(resultByRow.get(row) ?? null, {
          group: name,
          sourceId: row.id,
        });
        entries.push(...providerResult.entries);
        errors.push(...providerResult.errors);
        continue;
      }

      // ChatGPT's usage endpoint only accepts OAuth credentials, so an API-key
      // account reports its lack of ChatGPT quota instead of a quota number.
      if (row.resolveError !== undefined) {
        errors.push({
          label: name,
          message: `OpenAI API key could not be read: ${row.resolveError}`,
        });
        continue;
      }
      entries.push({
        kind: "value",
        accounting: {
          resultType: "status",
          acquisitionMethod: "local_runtime_accounting",
          ownership: "maintained",
          authority: "locally_derived",
          sourceId: row.id,
        },
        name,
        group: name,
        value: "ChatGPT quota unavailable for API key",
      });
    }

    const providerResult =
      entries.length > 0 || errors.length > 0
        ? attemptedResult(entries, errors)
        : mapResult(await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs }));

    // The active account describes the status; a row OpenCode did not mark
    // active (e.g. an env-selected connection or a failed active lookup) must
    // not be reported as the active one.
    const activeRow = rows.find((row) => row.active);
    let authConfigured = "false";
    let authSource = "(none)";
    let tokenStatus = "(none)";
    let tokenExpiresAt = "(none)";
    if (activeRow) {
      if (activeRow.value.type === "api") {
        authConfigured = "true";
        authSource = activeRow.integrationId;
        tokenStatus = activeRow.resolveError !== undefined ? "failed" : "api key";
      } else {
        const auth = credentials.find(({ row }) => row === activeRow)?.auth;
        if (auth) {
          const expiresAt = auth.state === "configured" ? auth.expiresAt : undefined;
          authConfigured = "true";
          authSource = auth.sourceKey;
          tokenStatus =
            auth.state === "failed"
              ? "failed"
              : expiresAt && expiresAt < Date.now()
                ? "expired"
                : "valid";
          tokenExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : "(none)";
        }
      }
    } else if (rows.length > 0) {
      // Stored accounts exist, but which one is active is unknown.
      authConfigured = "true";
      authSource = "unknown";
      tokenStatus = "unknown";
      tokenExpiresAt = "unknown";
    }
    return withStatusDetails(
      providerResult,
      statusDetailsFromRecord({
        auth_configured: authConfigured,
        auth_source: authSource,
        token_status: tokenStatus,
        token_expires_at: tokenExpiresAt,
      }),
    );
  },
};
