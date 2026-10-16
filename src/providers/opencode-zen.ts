import { safeErrorText } from "../core/redact.js";
import type { DebugDetail } from "../core/types.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import {
  consoleBaseUrl,
  type OpenCodeConsoleCredential,
  resolveOpenCodeConsoleAuth,
} from "../lib/opencode-console-auth.js";
import {
  MEMBER_BUDGET_NOTE,
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { resolvedCredentialPolicy } from "./cache-policies.js";
import { failedAccount, MONTHLY, type ProviderFetchResult, type ProviderRow } from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

const OPENCODE_ZEN_GROUP = "OpenCode Zen";
const USD_UNIT = { kind: "currency", code: "USD" } as const;
const LOGIN_HINT = "Run `opencode auth login opencode`.";

/** True when the user listed `opencode` in `enabledProviders` instead of using auto mode. */
function isExplicitlyEnabled(ctx: QuotaProviderContext): boolean {
  return (
    !ctx.config.automaticDiscovery &&
    Array.isArray(ctx.config.enabledProviders) &&
    ctx.config.enabledProviders.includes("opencode")
  );
}

function signInFailed(state: "expired" | "invalid", detail: string): ProviderFetchResult {
  return {
    attempted: true,
    accounts: [
      failedAccount(
        OPENCODE_ZEN_GROUP,
        `OpenCode Console sign-in failed: ${detail}. ${LOGIN_HINT}`,
      ),
    ],
    debug: [{ key: "console_auth_state", value: state }],
  };
}

/** Never includes the token. */
function consoleStatusDetails(credential: OpenCodeConsoleCredential): DebugDetail[] {
  return statusDetailsFromRecord({
    console_auth_state: "configured",
    console_server: consoleBaseUrl(credential),
    console_org: credential.orgName ?? credential.orgId ?? "(none)",
  });
}

function zenUsdDecimal(value: number): string {
  return value.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
}

function usd(value: number) {
  return { decimal: zenUsdDecimal(value), unit: USD_UNIT };
}

const ZEN_ROW = {
  method: "remote_api",
  authority: "provider_reported",
  prominence: "primary",
} as const;

export const opencodeZenProvider: QuotaProvider = {
  id: "opencode",
  cachePolicy: resolvedCredentialPolicy("opencode", async () => {
    const resolved = await resolveOpenCodeConsoleAuth();
    if (resolved.state !== "configured") return null;
    const { credential } = resolved;
    // The identity distinguishes accounts within the same org (member budgets
    // are queried per account): org + account, else the account, else the
    // token. The Console URL qualifies it because org ids can collide across
    // self-hosted Console URLs.
    return {
      credential:
        credential.orgId && credential.accountId
          ? JSON.stringify([credential.orgId, credential.accountId])
          : (credential.orgId ?? credential.accountId ?? credential.accessToken),
      principalKind: credential.orgId || credential.accountId ? "stable-id" : "credential",
      qualifiers: [consoleBaseUrl(credential)],
    };
  }),

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // An expired or failed sign-in stays available so fetch() can show its hint.
    // Without a Console sign-in, auto mode stays quiet; an explicit
    // enabledProviders entry keeps Zen so fetch() can show the sign-in hint.
    const consoleAuth = await resolveOpenCodeConsoleAuth();
    return consoleAuth.state !== "none" || isExplicitlyEnabled(ctx);
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const consoleAuth = await resolveOpenCodeConsoleAuth();

    if (consoleAuth.state === "none") {
      const debug = [{ key: "console_auth_state", value: "none" }];
      return isExplicitlyEnabled(ctx)
        ? {
            attempted: true,
            accounts: [
              failedAccount(OPENCODE_ZEN_GROUP, `No OpenCode Console sign-in found. ${LOGIN_HINT}`),
            ],
            debug,
          }
        : { attempted: false, accounts: [], debug };
    }

    if (consoleAuth.state === "invalid") {
      return signInFailed("invalid", safeErrorText(consoleAuth.error));
    }

    if (consoleAuth.state === "expired") {
      // OpenCode refreshes the Console token when it is read, so this is rare.
      return signInFailed("expired", "the sign-in expired");
    }

    const { credential } = consoleAuth;
    const statusDetails = consoleStatusDetails(credential);

    const result = await queryOpenCodeZenQuota(credential, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result.success) {
      return {
        attempted: true,
        accounts: [failedAccount(OPENCODE_ZEN_GROUP, result.error)],
        debug: [...statusDetails, { key: "live_fetch_error", value: result.error }],
      };
    }

    const { data } = result;
    const balanceUsd = data.balance / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    const configuredMonthlyLimit = ctx.config?.opencodeMonthlyLimit;
    const effectiveMonthlyLimit = configuredMonthlyLimit ?? data.monthlyLimit;
    const monthlyUsageUsd =
      data.monthlyUsage === null ? null : data.monthlyUsage / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;

    const hasMonthlyUsage =
      monthlyUsageUsd !== null && Number.isFinite(monthlyUsageUsd) && monthlyUsageUsd >= 0;
    // A member budget of $0 is a real blocking limit; a $0 credit limit or setting is no limit.
    const zeroBudgetActive = data.budgetSource === "member_budget" && effectiveMonthlyLimit === 0;
    const hasMonthlyBudget =
      effectiveMonthlyLimit !== null &&
      Number.isFinite(effectiveMonthlyLimit) &&
      (effectiveMonthlyLimit > 0 || zeroBudgetActive) &&
      hasMonthlyUsage;
    const rows: ProviderRow[] = [];

    if (hasMonthlyBudget) {
      const monthlyRemainingUsd = Math.max(0, effectiveMonthlyLimit - monthlyUsageUsd);
      rows.push({
        ...MONTHLY,
        ...ZEN_ROW,
        type: "budget",
        authority: "locally_derived",
        percentRemaining:
          effectiveMonthlyLimit > 0
            ? Math.min(100, (monthlyRemainingUsd / effectiveMonthlyLimit) * 100)
            : 0,
        used: usd(monthlyUsageUsd),
        limit: usd(effectiveMonthlyLimit),
        remaining: usd(monthlyRemainingUsd),
        ...(data.budgetResetIso ? { resetsAt: data.budgetResetIso } : {}),
      });
    } else if (hasMonthlyUsage) {
      // No limit to measure against: still show this month's real spend.
      rows.push({ ...MONTHLY, ...ZEN_ROW, type: "usage", amount: usd(monthlyUsageUsd) });
    }

    rows.push({
      ...ZEN_ROW,
      key: "balance",
      label: "Balance",
      type: "balance",
      prominence: hasMonthlyBudget ? "supplementary" : "primary",
      amount: usd(balanceUsd),
    });
    if (data.reload !== null) {
      rows.push({
        ...ZEN_ROW,
        key: "auto_reload",
        label: "Auto reload",
        type: "status",
        prominence: "supplementary",
        flag: data.reload,
      });
    }

    const usdText = (value: number) => `USD ${zenUsdDecimal(value)}`;
    return {
      attempted: true,
      accounts: [
        {
          name: OPENCODE_ZEN_GROUP,
          rows,
          errors: result.errors.map((message) => ({ message })),
        },
      ],
      debug: [
        ...statusDetails,
        ...statusDetailsFromRecord({
          balance_usd: usdText(balanceUsd),
          monthly_limit_usd: data.monthlyLimit === null ? "(none)" : usdText(data.monthlyLimit),
          monthly_usage_usd: monthlyUsageUsd === null ? "(unknown)" : usdText(monthlyUsageUsd),
          budget_source: data.budgetSource,
          member_budget_note: data.memberBudgetsSkipped ? MEMBER_BUDGET_NOTE : undefined,
          auto_reload: data.reload === null ? "(unknown)" : String(data.reload),
          auto_reload_amount_raw: data.reloadAmount === null ? "(none)" : String(data.reloadAmount),
          auto_reload_trigger_raw:
            data.reloadTrigger === null ? "(none)" : String(data.reloadTrigger),
          live_fetch_error: result.errors.length > 0 ? result.errors.join(" | ") : undefined,
        }),
      ],
    };
  },
};
