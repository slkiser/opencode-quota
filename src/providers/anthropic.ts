/**
 * Anthropic Claude: the 5h, weekly, Usage Credits and Fable weekly windows of each Claude login
 * stored in OpenCode, or of the login the Claude CLI or its credentials file holds.
 */

import type { DebugDetail } from "../core/types.js";
import {
  type AnthropicDiagnostics,
  type AnthropicLogin,
  type AnthropicQuotaResult,
  anthropicLoginsIdentity,
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuotaWithOAuth,
  readAnthropicLogins,
} from "../lib/anthropic.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
import {
  FIVE_HOUR,
  type FetchError,
  failedAccount,
  fetchEachLogin,
  fetchError,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  WEEKLY,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

/** The 5h, Weekly, Usage Credits and Fable weekly rows of one Claude account. */
function quotaRows(quota: AnthropicQuotaResult, method: ProviderRow["method"]): ProviderRow[] {
  const rows = [
    quotaRow({
      ...FIVE_HOUR,
      percentRemaining: quota.five_hour.percentRemaining,
      resetsAt: quota.five_hour.resetTimeIso,
    }),
    quotaRow({
      ...WEEKLY,
      percentRemaining: quota.seven_day.percentRemaining,
      resetsAt: quota.seven_day.resetTimeIso,
    }),
  ];
  if (quota.extra_usage) {
    rows.push(
      quotaRow({
        key: "extra_usage",
        label: "Extra usage",
        window: "month",
        percentRemaining: quota.extra_usage.percentRemaining,
      }),
    );
  }
  if (quota.fable_weekly) {
    rows.push(
      quotaRow({
        key: "weekly_fable",
        label: "Fable",
        window: "week",
        percentRemaining: quota.fable_weekly.percentRemaining,
        resetsAt: quota.fable_weekly.resetTimeIso,
      }),
    );
  }
  return rows.map((row) => ({ ...row, method }));
}

const LOGIN_HINT = "Run `opencode auth login anthropic`.";

/** One OpenCode login's rows: one usage request for a usable token, else why it has none. */
async function fetchOpenCodeLogin(
  auth: AnthropicLogin["auth"],
  requestTimeoutMs: number | undefined,
): Promise<{ rows: ProviderRow[]; errors: FetchError[]; rejected?: true }> {
  if (auth.state === "failed") {
    return {
      rows: [],
      errors: [{ message: `Anthropic sign-in could not be read: ${auth.error}. ${LOGIN_HINT}` }],
    };
  }
  if (auth.state === "expired") {
    return { rows: [], errors: [{ message: `Anthropic sign-in expired. ${LOGIN_HINT}` }] };
  }
  const result = await queryAnthropicQuotaWithOAuth(auth.accessToken, requestTimeoutMs);
  if (!result.success) {
    return {
      rows: [],
      errors: [fetchError(result.error, result.facts)],
      ...(result.rejected ? { rejected: true } : {}),
    };
  }
  return { rows: quotaRows(result, "remote_api"), errors: [] };
}

/** The Claude CLI's details for /quota_status. */
function cliStatusDetails(diagnostics: AnthropicDiagnostics) {
  return statusDetailsFromRecord({
    cli_installed: diagnostics.installed ? "true" : "false",
    cli_version: diagnostics.version ?? "(none)",
    binary_path: diagnostics.binaryPath ?? "(none)",
    auth_status: diagnostics.authStatus,
    quota_supported: diagnostics.quotaSupported ? "true" : "false",
    quota_source: diagnostics.quotaSource === "none" ? "(none)" : diagnostics.quotaSource,
    oauth_credential_source: diagnostics.oauthCredentialSource ?? "(none)",
    checked_commands: diagnostics.checkedCommands.join(" | ") || "(none)",
  });
}

/** The Claude CLI's diagnostics, or the status details and error of a probe that threw. */
async function probeClaudeCli(options: {
  binaryPath?: string;
  requestTimeoutMs?: number;
}): Promise<AnthropicDiagnostics | { failure: string; debug: DebugDetail[] }> {
  try {
    return await getAnthropicDiagnostics(options);
  } catch (error) {
    const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
    return {
      failure: `Claude CLI probe failed: ${message}`,
      debug: statusDetailsFromRecord({ cli_installed: "false" }),
    };
  }
}

/**
 * The Claude CLI's own quota, or the usage endpoint asked with
 * Claude's own credentials. Not set up when the CLI is missing or signed out.
 */
async function fetchFromClaudeCli(options: {
  binaryPath?: string;
  requestTimeoutMs?: number;
}): Promise<ProviderFetchResult> {
  const diagnostics = await probeClaudeCli(options);
  if ("failure" in diagnostics) {
    return {
      attempted: true,
      accounts: [failedAccount("Claude", diagnostics.failure)],
      debug: diagnostics.debug,
    };
  }

  const debug = cliStatusDetails(diagnostics);
  if (diagnostics.quota) {
    const method =
      diagnostics.quotaSource === "claude-auth-status-json" ? "local_cli" : "remote_api";
    return {
      attempted: true,
      accounts: [{ name: "Claude", rows: quotaRows(diagnostics.quota, method), errors: [] }],
      debug,
    };
  }
  const signedIn =
    diagnostics.authStatus === "authenticated" || diagnostics.oauthCredentialSource !== undefined;
  if (signedIn && diagnostics.message) {
    return {
      attempted: true,
      accounts: [failedAccount("Claude", diagnostics.message, diagnostics.facts)],
      debug,
    };
  }
  return { attempted: false, accounts: [], debug };
}

/** Whether the selected Anthropic runtime, or the only one available, uses Claude Code's login. */
async function usesClaudeCodeCredentials(ctx: QuotaProviderContext): Promise<boolean> {
  const currentProviderId = (
    ctx.config.currentProviderID ??
    resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config.currentModel ?? "" })
      ?.providerId
  )
    ?.trim()
    .toLowerCase();
  if (currentProviderId === "claude-code") return true;
  if (currentProviderId === "anthropic") return false;

  try {
    const runtimeIds = await ctx.resolveRuntimeProviderIds();
    return runtimeIds.has("claude-code") && !runtimeIds.has("anthropic");
  } catch {
    return false;
  }
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",
  cachePolicy: {
    kind: "resolved-auth",
    resolveScope: async (ctx) =>
      (await usesClaudeCodeCredentials(ctx)) ? "claude-code" : "opencode-auth",
    async resolveIdentity(ctx) {
      const logins = (await usesClaudeCodeCredentials(ctx)) ? [] : await readAnthropicLogins();
      return anthropicLoginsIdentity(logins, {
        binaryPath: ctx.config.anthropicBinaryPath,
      });
    },
  },

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "anthropic",
      fallbackOnError: false,
    });
    if (!providerAvailable) return false;

    return await hasAnthropicCredentialsConfigured({
      binaryPath: ctx.config?.anthropicBinaryPath,
      useClaudeCodeCredentials: await usesClaudeCodeCredentials(ctx),
    });
  },

  matchesCurrentModel(model: string): boolean {
    const normalized = model.toLowerCase();
    return normalized.startsWith("anthropic/") || normalized.startsWith("claude-code/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const cliOptions = {
      binaryPath: ctx.config?.anthropicBinaryPath,
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    };
    if (await usesClaudeCodeCredentials(ctx)) return await fetchFromClaudeCli(cliOptions);
    const logins = await readAnthropicLogins();
    if (logins.length === 0) return await fetchFromClaudeCli(cliOptions);

    // Only the OpenCode logins are checked, so the Claude CLI starts only when Anthropic
    // rejects one of them: its details then say whether Claude's own credentials still work.
    let rejected = false;
    const accounts = await fetchEachLogin({
      providerName: "Claude",
      logins,
      async fetchLogin({ auth }) {
        const fetched = await fetchOpenCodeLogin(auth, cliOptions.requestTimeoutMs);
        if (fetched.rejected) rejected = true;
        return fetched;
      },
    });
    if (rejected) {
      const diagnostics = await probeClaudeCli(cliOptions);
      const debug = "failure" in diagnostics ? diagnostics.debug : cliStatusDetails(diagnostics);
      return { attempted: true, accounts, debug };
    }
    const quotaSupported = accounts.some((account) => account.rows.length > 0);
    return {
      attempted: true,
      accounts,
      debug: statusDetailsFromRecord({
        quota_supported: quotaSupported ? "true" : "false",
        quota_source: quotaSupported ? "opencode-auth-oauth-api" : "(none)",
        oauth_credential_source: "opencode-auth",
      }),
    };
  },
};
