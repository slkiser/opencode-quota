/**
 * Anthropic Claude: the 5h, weekly, Usage Credits and Fable weekly windows of each Claude login
 * stored in OpenCode, the Claude CLI's login, or named Claude Code plugin observations.
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
import { claudeCodePluginUsagePath, readClaudeCodePluginUsage } from "../lib/claude-code-plugin.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import {
  claudeCodePluginAccount,
  claudeCodePluginAccountLabel,
  claudeCodePluginProviderId,
  getQuotaProviderIdsForRuntimeId,
} from "../lib/provider-metadata.js";
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

function quotaRows(quota: AnthropicQuotaResult, method: ProviderRow["method"]): ProviderRow[] {
  const rows: ProviderRow[] = [];
  // A plan without a 5-hour limit (Ultra) or a weekly one (Enterprise) has no such row.
  if (quota.five_hour) {
    rows.push(
      quotaRow({
        ...FIVE_HOUR,
        percentRemaining: quota.five_hour.percentRemaining,
        resetsAt: quota.five_hour.resetTimeIso,
      }),
    );
  }
  if (quota.seven_day) {
    rows.push(
      quotaRow({
        ...WEEKLY,
        percentRemaining: quota.seven_day.percentRemaining,
        resetsAt: quota.seven_day.resetTimeIso,
      }),
    );
  }
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

/**
 * The OpenCode providers that run Claude Code, so their quota is Claude Code's login:
 * openchamber's `claude-code` and OpenCode's own Claude Agent provider, `claude-agent`.
 */
const CLAUDE_CODE_RUNTIME_IDS = ["claude-code", "claude-agent"];

function selectedProviderId(ctx: QuotaProviderContext): string | undefined {
  return (
    ctx.config.currentProviderID ??
    resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config.currentModel ?? "" })
      ?.providerId
  )
    ?.trim()
    .toLowerCase();
}

async function pluginAccounts(ctx: QuotaProviderContext): Promise<string[] | undefined> {
  const selected = selectedProviderId(ctx);
  if (selected === "anthropic" || (selected && CLAUDE_CODE_RUNTIME_IDS.includes(selected)))
    return undefined;
  const namedSelected = selected !== undefined && claudeCodePluginAccount(selected) !== undefined;
  try {
    const runtimeIds = await ctx.resolveRuntimeProviderIds();
    if (!namedSelected && runtimeIds.has("anthropic")) return undefined;
    const accounts = [
      ...new Set(
        [...runtimeIds].flatMap((id) => {
          const account = claudeCodePluginAccount(id);
          return account === undefined ? [] : [account];
        }),
      ),
    ].sort();
    return accounts.length || namedSelected ? accounts : undefined;
  } catch {
    return namedSelected ? [] : undefined;
  }
}

/** Whether the selected Anthropic runtime, or the only one available, uses Claude Code's login. */
async function usesClaudeCodeCredentials(ctx: QuotaProviderContext): Promise<boolean> {
  const currentProviderId = selectedProviderId(ctx);
  if (currentProviderId && CLAUDE_CODE_RUNTIME_IDS.includes(currentProviderId)) return true;
  if (currentProviderId === "anthropic") return false;

  try {
    const runtimeIds = await ctx.resolveRuntimeProviderIds();
    return CLAUDE_CODE_RUNTIME_IDS.some((id) => runtimeIds.has(id)) && !runtimeIds.has("anthropic");
  } catch {
    return false;
  }
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",
  cachePolicy: {
    kind: "resolved-auth",
    async resolveScope(ctx) {
      const accounts = await pluginAccounts(ctx);
      if (accounts !== undefined) {
        return JSON.stringify(["claude-code-plugin", claudeCodePluginUsagePath(), accounts]);
      }
      return (await usesClaudeCodeCredentials(ctx)) ? "claude-code" : "opencode-auth";
    },
    async resolveIdentity(ctx) {
      if ((await pluginAccounts(ctx)) !== undefined) return null;
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
    const accounts = await pluginAccounts(ctx);
    if (accounts !== undefined) return accounts.length > 0;

    return await hasAnthropicCredentialsConfigured({
      binaryPath: ctx.config?.anthropicBinaryPath,
      useClaudeCodeCredentials: await usesClaudeCodeCredentials(ctx),
    });
  },

  matchesCurrentModel(model: string): boolean {
    const [providerId] = model.split("/");
    return model.includes("/") && getQuotaProviderIdsForRuntimeId(providerId).includes("anthropic");
  },

  // Claude Code and Claude Agent use the login of the plugin's `default` account (`~/.claude`).
  async usageAccounts(ctx: QuotaProviderContext) {
    const accounts = await pluginAccounts(ctx);
    if (!accounts?.length) return undefined;
    const byProvider: Record<string, string> = Object.fromEntries(
      accounts.map((account) => [
        claudeCodePluginProviderId(account),
        claudeCodePluginAccountLabel(account),
      ]),
    );
    if (accounts.includes("default")) {
      for (const id of CLAUDE_CODE_RUNTIME_IDS) {
        byProvider[id] = claudeCodePluginAccountLabel("default");
      }
    }
    return byProvider;
  },

  async liveLocalUsage(ctx: QuotaProviderContext) {
    return (await pluginAccounts(ctx)) !== undefined;
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const accountsFromPlugin = await pluginAccounts(ctx);
    if (accountsFromPlugin !== undefined)
      return await readClaudeCodePluginUsage(accountsFromPlugin);
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
