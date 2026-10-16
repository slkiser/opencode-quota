import { createHash } from "node:crypto";

import type { Amount, DebugDetail, QuotaWindow } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import {
  type AlibabaTokenPlanClosedResult,
  type AlibabaTokenPlanCredentialMarkers,
  type AlibabaTokenPlanSeat,
  type AlibabaTokenPlanSeatResult,
  type AlibabaTokenPlanWindow,
  alibabaTokenPlanCredentialHalves,
  isAlibabaTokenPlanSupportedPlatform,
  NO_WINDOW_HINT,
  queryAlibabaTokenPlanQuota,
  queryAlibabaTokenPlanSeats,
  resolveAlibabaTokenPlanIdentity,
} from "../lib/alibaba-token-plan.js";
import type {
  QuotaProvider,
  QuotaProviderCachePolicy,
  QuotaProviderContext,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { type ResolvedCredential, resolvedCredentialPolicy } from "./cache-policies.js";
import {
  type AccountResult,
  failedAccount,
  keySlug,
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

const CREDIT_UNIT = { kind: "count", unit: "credit" } as const;
/** Credits carry six decimals; a difference of two would otherwise show binary noise past them. */
const CREDIT_DECIMALS = 6;

/** Credits as a display amount, rounded to the six decimals the provider reports. */
function creditAmount(value: number): Amount {
  const factor = 10 ** CREDIT_DECIMALS;
  return {
    decimal: accountingDecimalFromNumber(Math.round(value * factor) / factor),
    unit: CREDIT_UNIT,
  };
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

/**
 * One team seat as a `team.<AccountName>` row. The percent and `used` come from `parseSeat`, so
 * both carry the same cycle arithmetic; `amount` carries the surplus even when there is no total,
 * and a seat reporting no usage at all carries text, so the row still holds a value and survives.
 */
function seatRow(seat: AlibabaTokenPlanSeat, key: string): ProviderRow {
  // Only `percentRemaining` or `amount` satisfy `core/validate.ts`, and both need a surplus.
  const hasValue = seat.percentRemaining !== undefined || seat.surplus !== undefined;
  return {
    key: `team.${key}`,
    label: "Credits",
    type: "quota",
    method: "local_cli",
    authority: "provider_reported",
    prominence: "primary",
    window: "month",
    ...(seat.percentRemaining !== undefined ? { percentRemaining: seat.percentRemaining } : {}),
    ...(seat.total !== undefined ? { limit: creditAmount(seat.total) } : {}),
    ...(seat.surplus !== undefined ? { amount: creditAmount(seat.surplus) } : {}),
    ...(seat.used !== undefined ? { used: creditAmount(seat.used) } : {}),
    ...(seat.resetsAt !== undefined ? { resetsAt: seat.resetsAt } : {}),
    ...(seat.startedAt !== undefined ? { windowStartedAt: seat.startedAt } : {}),
    // The cycle's own start, so the window's span is exact: a seat's cycle is 30 days, not a
    // calendar month, and without it the row cannot say how fast the credits are being spent.
    ...(hasValue ? {} : { text: "no usage reported" }),
  };
}

/** The brand `rows.ts` strips, leaving the seat's own account name. */
function seatAccountName(label: string, seatName: string): string {
  return `${label} (${seatName})`;
}

/**
 * The row key parts for the seats, in order: each seat's slugged name, or a digest of its raw name
 * when that slug is empty or shared with a different name. A key drives the user's hide/rename
 * settings and the store's row slot, so it must follow the name alone, never the seat's position,
 * while every distinct name gets its own.
 */
function seatKeys(seats: readonly AlibabaTokenPlanSeat[]): string[] {
  const namesBySlug = new Map<string, Set<string>>();
  for (const seat of seats) {
    const slug = keySlug(seat.name);
    if (!slug) continue;
    const owners = namesBySlug.get(slug) ?? new Set<string>();
    owners.add(seat.name);
    namesBySlug.set(slug, owners);
  }
  return seats.map((seat) => {
    const slug = keySlug(seat.name);
    // A name digest is order-free; a plain slug is only safe while one name owns it.
    if (slug && namesBySlug.get(slug)?.size === 1) return slug;
    const digest = createHash("sha256").update(seat.name).digest("hex").slice(0, 8);
    return `${slug || "seat"}_${digest}`;
  });
}

/** The user's own request timeout when they set one; none otherwise, so the CLI's own applies. */
function alibabaRequestTimeoutMs(ctx: QuotaProviderContext): number | undefined {
  return ctx.config?.requestTimeoutMsConfigured ? ctx.config.requestTimeoutMs : undefined;
}

/**
 * Both commands' outcomes, each reported on its own side: the personal console command and the
 * OpenAPI seat command fail separately, so one never hides the other.
 */
function statusDetails(
  personal: AlibabaTokenPlanClosedResult,
  seats: AlibabaTokenPlanSeatResult,
): DebugDetail[] {
  const details = personal.ok
    ? statusDetailsFromRecord({
        cli_available: "true",
        platform: process.platform,
        windows: personal.monthly ? MONTHLY.key : "(none)",
        window_hint: personal.monthly ? undefined : NO_WINDOW_HINT,
      })
    : statusDetailsFromRecord({
        cli_available: personal.error.kind === "executable_not_found" ? "false" : "true",
        platform: process.platform,
        failure_kind: personal.error.kind,
      });
  if (seats.ok) {
    if (seats.seats.length > 0) details.push({ key: "seat_windows", value: "credits" });
  } else {
    details.push({ key: "seat_failure_kind", value: seats.error.kind });
  }
  return details;
}

export const alibabaTokenPlanProvider: QuotaProvider = createTokenPlanProvider();

/**
 * The account the readings belong to: the access key id when the CLI reports one, since the
 * console token is minted from it and so names the same account, and a key id does not rotate.
 * The console token's own mask is the fallback: it names the account too, but the CLI replaces
 * that token when it expires, so an identity built on it moves with the token.
 */
function alibabaTokenPlanAccountPrincipal(
  markers: AlibabaTokenPlanCredentialMarkers,
): ResolvedCredential | null {
  if (markers.openapiAccessKeyId) {
    return { credential: markers.openapiAccessKeyId, principalKind: "stable-id" };
  }
  if (markers.consoleMasked) {
    return { credential: markers.consoleMasked, principalKind: "credential" };
  }
  return null;
}

function alibabaTokenPlanIdentityPolicy(id: CanonicalQuotaProviderId): QuotaProviderCachePolicy {
  return resolvedCredentialPolicy(id, async (ctx) => {
    const markers = await resolveAlibabaTokenPlanIdentity({
      requestTimeoutMs: ctx.config.requestTimeoutMs,
      runtime: { cwd: ctx.workspaceRoot },
    });
    // No credential at all: there is no account to key a slot on.
    return markers ? alibabaTokenPlanAccountPrincipal(markers) : null;
  });
}

function createTokenPlanProvider(): QuotaProvider {
  const id = "alibaba-token-plan";
  const label = GROUP_LABEL;
  const group = personalGroup(label);
  return {
    id,
    cachePolicy: alibabaTokenPlanIdentityPolicy(id),

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
      const runtime = { cwd: ctx.workspaceRoot };
      const requestTimeoutMs = alibabaRequestTimeoutMs(ctx);
      // Independent commands with different auth: run both, and let each report its own failure.
      // `bl auth status` rides along: it is the same memoised read the cache identity comes from,
      // so it costs no second spawn and both answers come from one reply.
      const [personal, seats, markers] = await Promise.all([
        queryAlibabaTokenPlanQuota({ requestTimeoutMs, runtime }),
        queryAlibabaTokenPlanSeats({ requestTimeoutMs, runtime }),
        resolveAlibabaTokenPlanIdentity({ requestTimeoutMs, runtime }),
      ]);
      const debug = statusDetails(personal, seats);

      if (!personal.ok && personal.error.kind === "unsupported_platform") {
        return { attempted: false, accounts: [], debug };
      }

      // Gated here because an account with no rows and no errors is invisible to rows.ts, so nothing
      // is recorded and nothing backs off on a capability the user does not have. A block `bl`
      // reports is a set-up session that may merely have expired, so a failure there is still real.
      const halves = alibabaTokenPlanCredentialHalves(markers);
      const accounts: AccountResult[] = [];
      // Suppress a failure, never data: what `bl` actually returned outranks a missing marker,
      // which `bl auth status` memoises and can lag behind the command it describes.
      const showConsole = halves.console || (personal.ok && personal.monthly !== undefined);
      const showSeats = halves.openapi || (seats.ok && seats.seats.length > 0);
      if (showConsole) {
        if (!personal.ok) {
          accounts.push(failedAccount(group, personal.error.message, personal.error.facts));
        } else if (personal.monthly) {
          accounts.push({ name: group, rows: [windowRow(personal.monthly)], errors: [] });
        }
        // A signed-in reply carrying no window is an absence, not a fault: the account may not
        // sell a personal plan at all, and `window_hint` already carries `bl`'s own wording for
        // the ambiguity. Nothing is pushed, which leaves it invisible rather than painted red.
      }
      if (showSeats) {
        if (seats.ok) {
          const keys = seatKeys(seats.seats);
          for (const [index, seat] of seats.seats.entries()) {
            accounts.push({
              name: seatAccountName(label, seat.name),
              rows: [seatRow(seat, keys[index])],
              errors: [],
            });
          }
        } else {
          accounts.push(failedAccount(`${label} (team)`, seats.error.message, seats.error.facts));
        }
      }

      return { attempted: true, accounts, debug };
    },
  };
}
