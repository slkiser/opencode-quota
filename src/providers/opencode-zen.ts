import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import {
  consoleLoginIdentity,
  consoleSignInFailure,
  type OpenCodeConsoleAuthState,
  resolveOpenCodeConsoleAuth,
} from "../lib/opencode-console-auth.js";
import {
  MEMBER_BUDGET_NOTE,
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { failedAccount, MONTHLY, type ProviderFetchResult, type ProviderRow } from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

const OPENCODE_ZEN_GROUP = "OpenCode Zen";
const USD_UNIT = { kind: "currency", code: "USD" } as const;
const LOGIN_HINT = "Run `opencode auth login opencode`.";

/** True when the user listed `opencode` in `enabledProviders` instead of using auto mode. */
function isExplicitlyEnabled(ctx: QuotaProviderContext): boolean {
  return !ctx.config.automaticDiscovery && ctx.config.enabledProviders.includes("opencode");
}

function signInFailed(
  auth: Extract<OpenCodeConsoleAuthState, { state: "expired" | "invalid" }>,
): ProviderFetchResult {
  return {
    attempted: true,
    accounts: [failedAccount(OPENCODE_ZEN_GROUP, consoleSignInFailure(auth).message)],
    debug: [{ key: "console_auth_state", value: auth.state }],
  };
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
  cachePolicy: {
    kind: "resolved-auth",
    async resolveIdentity() {
      const resolved = await resolveOpenCodeConsoleAuth();
      return resolved.state === "configured"
        ? await consoleLoginIdentity("opencode", resolved.credential)
        : null;
    },
  },

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

    // OpenCode refreshes the Console token when it is read, so an expired one is rare.
    if (consoleAuth.state === "invalid" || consoleAuth.state === "expired") {
      return signInFailed(consoleAuth);
    }

    const { credential } = consoleAuth;
    // Never the token, the Console server or the organization.
    const consoleDetail = { key: "console_auth_state", value: "configured" };

    const result = await queryOpenCodeZenQuota(credential, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result.success) {
      return {
        attempted: true,
        accounts: [failedAccount(OPENCODE_ZEN_GROUP, result.error, result.facts)],
        debug: [consoleDetail, { key: "live_fetch_error", value: result.error }],
      };
    }

    const { data } = result;
    const budgetLimit = ctx.config?.opencodeMonthlyLimit ?? data.monthlyLimit;
    // A member budget of $0 is a real blocking cap; a $0 setting is no limit.
    const monthlyLimit =
      budgetLimit !== null &&
      Number.isFinite(budgetLimit) &&
      (budgetLimit > 0 || (budgetLimit === 0 && data.monthlyLimit === 0))
        ? budgetLimit
        : null;
    const monthlyUsageUsd =
      data.monthlyUsage === null ? null : data.monthlyUsage / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;

    const rows: ProviderRow[] = [];
    // Money always leads: the collapsed line shows the spendable amount, not a spend cap.
    if (data.creditLimit !== null) {
      const drawn = Math.max(0, data.creditLimit - data.available);
      rows.push({
        ...ZEN_ROW,
        key: "credit",
        label: "Credit",
        type: "budget",
        used: usd(drawn),
        limit: usd(data.creditLimit),
        text: `${fmtUsdAmount(drawn)} drawn | ${fmtUsdAmount(data.creditLimit)} limit`,
      });
    } else {
      rows.push({
        ...ZEN_ROW,
        key: "balance",
        label: "Balance",
        type: "balance",
        amount: usd(data.available),
      });
    }

    // A Console member budget is a monthly cap on spend, not money, so it shows spend against
    // the cap instead of a bar that reads as quota left.
    if (monthlyLimit !== null && monthlyUsageUsd !== null) {
      rows.push({
        ...MONTHLY,
        ...ZEN_ROW,
        type: "budget",
        authority: "locally_derived",
        used: usd(monthlyUsageUsd),
        limit: usd(monthlyLimit),
        text: `${fmtUsdAmount(monthlyUsageUsd)} spent | ${fmtUsdAmount(monthlyLimit)} limit`,
        ...(data.budgetResetIso ? { resetsAt: data.budgetResetIso } : {}),
      });
    }

    if (data.reload !== null) {
      rows.push({
        ...ZEN_ROW,
        key: "auto_reload",
        label: "Auto reload",
        type: "status",
        prominence: "supplementary",
        flag: data.reload,
        // A declined auto-reload is the reason a top-up never arrived, so it rides the row.
        ...(data.reloadFailure
          ? { text: `Auto reload failed: ${data.reloadFailure.slice(0, 150)}` }
          : {}),
      });
    }

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
        consoleDetail,
        ...statusDetailsFromRecord({
          budget_source: data.monthlyLimit === null ? undefined : "member_budget",
          member_budget_note: data.memberBudgetsSkipped ? MEMBER_BUDGET_NOTE : undefined,
          auto_reload: data.reload === null ? "(unknown)" : String(data.reload),
          live_fetch_error: result.errors.length > 0 ? result.errors.join(" | ") : undefined,
        }),
      ],
    };
  },
};
