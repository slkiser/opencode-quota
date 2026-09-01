/**
 * Anthropic Claude provider wrapper.
 *
 * Normalizes Claude CLI-exposed quota windows into generic toast entries.
 */

import {
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuota,
} from "../lib/anthropic.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
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

    if (result.extra_usage) {
      entries.push({
        accounting: {
          resultType: "quota",
          acquisitionMethod,
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Claude Usage Credits",
        group: "Claude",
        label: "Monthly:",
        percentRemaining: result.extra_usage.percentRemaining,
      });
    }

    return withStatusDetails(attemptedResult(entries), statusDetails);
  },
};
