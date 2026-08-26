/**
 * Anthropic Claude provider wrapper.
 *
 * Normalizes Claude CLI-exposed quota windows into generic toast entries.
 */

import {
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuota,
  queryAnthropicQuotaWithOAuth,
} from "../lib/anthropic.js";
import { resolveAnthropicOAuth } from "../lib/anthropic-auth.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { formatCredentialDisplayNames, readCredentialRows } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import type { AuthData } from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

export function getAnthropicNoDataMessage(): string {
  return "Quota unavailable via local Claude CLI or OAuth credentials";
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "anthropic",
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    return await hasAnthropicCredentialsConfigured({
      binaryPath: ctx.config?.anthropicBinaryPath,
    });
  },

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().startsWith("anthropic/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const options = {
      binaryPath: ctx.config?.anthropicBinaryPath,
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    };
    let statusDetails;
    let acquisitionMethod: QuotaToastEntry["accounting"]["acquisitionMethod"] = "local_cli";
    const databaseCredentials = (await readCredentialRows()).flatMap((row) => {
      if (row.integrationId !== "anthropic") return [];
      const auth = resolveAnthropicOAuth({ anthropic: row.value } as AuthData);
      return auth.state === "configured" ? [{ row, auth }] : [];
    });
    try {
      const diagnostics = await getAnthropicDiagnostics(options);
      const quota = diagnostics.quotaSupported ? diagnostics.quota : undefined;
      if (diagnostics.quotaSupported && diagnostics.quotaSource !== "claude-auth-status-json") {
        acquisitionMethod = "remote_api";
      }
      statusDetails = statusDetailsFromRecord({
        cli_installed: diagnostics.installed ? "true" : "false",
        cli_version: diagnostics.version ?? "(none)",
        auth_status: diagnostics.authStatus,
        quota_supported: diagnostics.quotaSupported ? "true" : "false",
        quota_source: diagnostics.quotaSource === "none" ? "(none)" : diagnostics.quotaSource,
        oauth_credential_source: diagnostics.oauthCredentialSource ?? "(none)",
        checked_commands: diagnostics.checkedCommands.join(" | ") || "(none)",
        message: diagnostics.message,
        five_hour_remaining: quota
          ? `${quota.five_hour.percentRemaining}% reset_at=${quota.five_hour.resetTimeIso ?? "(none)"}`
          : undefined,
        seven_day_remaining: quota
          ? `${quota.seven_day.percentRemaining}% reset_at=${quota.seven_day.resetTimeIso ?? "(none)"}`
          : undefined,
      });
    } catch (error) {
      statusDetails = statusDetailsFromRecord({
        cli_installed: "false",
        message: `failed to probe Claude CLI: ${sanitizeDisplayText(error instanceof Error ? error.message : String(error))}`,
      });
    }

    if (databaseCredentials.length > 0) {
      const results = await Promise.all(
        databaseCredentials.map(async ({ row, auth }) => ({
            row,
            result: await queryAnthropicQuotaWithOAuth(auth.accessToken, options.requestTimeoutMs),
          })),
      );
      const names = formatCredentialDisplayNames(
        "Claude",
        results.map(({ row }) => ({ row, fallbackName: "Claude" })),
      );
      const entries: QuotaToastEntry[] = [];
      const errors: QuotaProviderResult["errors"] = [];
      for (const [index, { row, result }] of results.entries()) {
        const group = names[index] ?? "Claude";
        if (!result?.success) {
          if (result) errors.push({ label: group, message: result.error });
          continue;
        }
        entries.push(
          ...[["5h", result.five_hour] as const, ["Weekly", result.seven_day] as const].map(
            ([label, window]) => ({
              accounting: {
                resultType: "quota" as const,
                acquisitionMethod: "remote_api" as const,
                ownership: "maintained" as const,
                authority: "provider_reported" as const,
                sourceId: row.id,
              },
              name: `${group} ${label}`,
              group,
              label: `${label}:`,
              percentRemaining: window.percentRemaining,
              resetTimeIso: window.resetTimeIso,
            }),
          ),
        );
      }
      return withStatusDetails(attemptedResult(entries, errors), statusDetails);
    }

    const result = await queryAnthropicQuota(options);
    if (!result) {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult("Claude", result.error), statusDetails);
    }

    const entries: QuotaToastEntry[] = [
      {
        accounting: {
          resultType: "quota",
          acquisitionMethod,
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        percentRemaining: result.five_hour.percentRemaining,
        resetTimeIso: result.five_hour.resetTimeIso,
      },
      {
        accounting: {
          resultType: "quota",
          acquisitionMethod,
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        percentRemaining: result.seven_day.percentRemaining,
        resetTimeIso: result.seven_day.resetTimeIso,
      },
    ];

    return withStatusDetails(attemptedResult(entries), statusDetails);
  },
};
