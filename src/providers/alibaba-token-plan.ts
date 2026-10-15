import type { QuotaWindow } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import {
  type AlibabaTokenPlanClosedResult,
  type AlibabaTokenPlanWindow,
  isAlibabaTokenPlanSupportedPlatform,
  NO_WINDOW_HINT,
  queryAlibabaTokenPlanQuota,
} from "../lib/alibaba-token-plan.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

/** The registration label; an account name must start with the brand `rows.ts` strips. */
const GROUP_LABEL = "Alibaba Token Plan";

/** The personal account's text: the one account that is not a seat. */
function personalGroup(label: string): string {
  return `${label} (personal)`;
}

/**
 * One calendar month back, clamped to that month's last day: a monthly cycle ends on the next
 * month's corresponding day at 23:59:59 (UTC+8), and on that month's last day when it has none.
 */
function oneCalendarMonthBefore(resetMs: number): number {
  const reset = new Date(resetMs);
  const month = (reset.getUTCMonth() + 11) % 12;
  const year = reset.getUTCMonth() === 0 ? reset.getUTCFullYear() - 1 : reset.getUTCFullYear();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(reset.getUTCDate(), lastDay);
  return Date.UTC(
    year,
    month,
    day,
    reset.getUTCHours(),
    reset.getUTCMinutes(),
    reset.getUTCSeconds(),
    reset.getUTCMilliseconds(),
  );
}

/**
 * The window's start: its own length before the reset, or a calendar month back for a month.
 * Without one the row cannot say how fast the quota is being spent.
 */
function windowStartIso(window: QuotaWindow, resetsAt: string | undefined): string | undefined {
  if (resetsAt === undefined) return undefined;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return undefined;
  const lengthMs = WINDOWS[window].lengthMs;
  const startMs = lengthMs !== undefined ? resetMs - lengthMs : oneCalendarMonthBefore(resetMs);
  return new Date(startMs).toISOString();
}

/** The monthly window the local Alibaba CLI reported. */
function windowRow(window: AlibabaTokenPlanWindow): ProviderRow {
  return {
    ...quotaRow({
      ...MONTHLY,
      // The row key names which half of the plan the row belongs to; the label still says what it
      // measures, and `MONTHLY.key` would name the window instead.
      key: "personal",
      percentRemaining: window.percentRemaining,
      resetsAt: window.resetTimeIso,
      // The reply says when the month resets but not when it began.
      windowStartedAt: windowStartIso("month", window.resetTimeIso),
    }),
    method: "local_cli",
  };
}

function statusDetailsFromResult(result: AlibabaTokenPlanClosedResult) {
  if (result.ok) {
    return statusDetailsFromRecord({
      cli_available: "true",
      platform: process.platform,
      windows: result.monthly ? MONTHLY.key : "(none)",
      window_hint: result.monthly ? undefined : NO_WINDOW_HINT,
    });
  }
  return statusDetailsFromRecord({
    cli_available: result.error.kind === "executable_not_found" ? "false" : "true",
    platform: process.platform,
    failure_kind: result.error.kind,
  });
}

/** The user's own request timeout when they set one; none otherwise, so the CLI's own applies. */
function alibabaRequestTimeoutMs(ctx: QuotaProviderContext): number | undefined {
  return ctx.config?.requestTimeoutMsConfigured ? ctx.config.requestTimeoutMs : undefined;
}

export const alibabaTokenPlanProvider: QuotaProvider = createTokenPlanProvider();

function createTokenPlanProvider(): QuotaProvider {
  const id = "alibaba-token-plan";
  const label = GROUP_LABEL;
  const group = personalGroup(label);
  return {
    id,
    cachePolicy: { kind: "uncached" },

    // Never probes PATH: availability comes from selection or the current runtime identity.
    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      if (!isAlibabaTokenPlanSupportedPlatform()) return false;

      const selected = await isCanonicalProviderAvailable({
        ctx,
        providerId: id,
        fallbackOnError: false,
      });
      if (selected || ctx.config.currentProviderID === id) return true;
      const currentModel = ctx.config.currentModel;
      return !!currentModel && modelProviderMatchesRuntimeId(currentModel, id);
    },

    matchesCurrentModel(model: string, context): boolean {
      if (context?.currentProviderID) {
        return context.currentProviderID === id;
      }
      return modelProviderMatchesRuntimeId(model, id);
    },

    async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
      const result = await queryAlibabaTokenPlanQuota({
        requestTimeoutMs: alibabaRequestTimeoutMs(ctx),
        runtime: { cwd: ctx.workspaceRoot },
      });
      const debug = statusDetailsFromResult(result);
      if (result.ok) {
        // A signed-in reply carrying no window is an absence, not a fault: the account may not
        // sell a personal plan at all, and `window_hint` already carries `bl`'s own wording for
        // the ambiguity. Nothing is pushed, which leaves it invisible rather than painted red.
        return {
          attempted: true,
          accounts: result.monthly
            ? [{ name: group, rows: [windowRow(result.monthly)], errors: [] }]
            : [],
          debug,
        };
      }
      if (result.error.kind === "unsupported_platform") {
        return { attempted: false, accounts: [], debug };
      }
      return {
        attempted: true,
        accounts: [failedAccount(group, result.error.message)],
        debug,
      };
    },
  };
}
