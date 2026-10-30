/** Alibaba's Token Plan and Coding Plan, from the official `bl` CLI; separate providers keep their row ids apart. */

import { createHash } from "node:crypto";

import type { ErrorFacts } from "../core/errors.js";
import type { Amount, DebugDetail, QuotaWindow } from "../core/types.js";
import { WINDOWS, classifyWindow } from "../core/windows.js";
import {
  ALIBABA_TOKEN_PLAN_ARGS,
  type AlibabaCodingPlanUsage,
  type AlibabaCredentialMarkers,
  type AlibabaErrorKind,
  type AlibabaSpawnKinds,
  type AlibabaTokenPlanClosedResult,
  type AlibabaTokenPlanSeat,
  type AlibabaTokenPlanSeatResult,
  type AlibabaTokenPlanWindow,
  alibabaCredentialHalves,
  CODING_PLAN_SPAWN_KINDS,
  isAlibabaTokenPlanSupportedPlatform,
  NO_QUOTA_DATA_HINT,
  parseAlibabaCodingPlanUsageJson,
  parseAlibabaTokenPlanUsageJson,
  queryAlibabaReply,
  queryAlibabaTokenPlanSeats,
  resolveAlibabaIdentity,
  USAGE_SPAWN_KINDS,
} from "../lib/alibaba.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { type ResolvedCredential, resolvedCredentialPolicy } from "./cache-policies.js";
import {
  type AccountResult,
  failedAccount,
  FIVE_HOUR,
  keySlug,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  type Slot,
  WEEKLY,
  windowRows,
  type WindowRow,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

type AlibabaCommandHalf = "console" | "openapi";

type AlibabaCommandResult =
  | { ok: true; accounts: AccountResult[]; debug: DebugDetail[] }
  | {
      ok: false;
      kind: AlibabaErrorKind;
      message: string;
      facts?: ErrorFacts;
      debug: DebugDetail[];
    };

type AlibabaRunOptions = {
  runtime: { cwd: string };
  requestTimeoutMs?: number;
};

/**
 * One `bl` command. A paging command reads the whole answer itself (`read`): two seats on different
 * pages can share a slug, so no single page can be keyed alone.
 */
type AlibabaCommand = {
  half: AlibabaCommandHalf;
  failureAccount?: string;
} & (
  | {
      args: readonly string[];
      /** The kinds its own failures report: exit 3 names the credential this command needs. */
      kinds: AlibabaSpawnKinds;
      parse: (text: string) => AlibabaCommandResult;
      read?: undefined;
    }
  | {
      read: (options: AlibabaRunOptions) => Promise<AlibabaCommandResult>;
      parse?: undefined;
    }
);

function failureResult(
  error: { kind: AlibabaErrorKind; message: string; facts?: ErrorFacts },
  debug: DebugDetail[],
): AlibabaCommandResult {
  return { ok: false, kind: error.kind, message: error.message, facts: error.facts, debug };
}

const TOKEN_PLAN_LABEL = "Alibaba Token Plan";

function withSuffix(label: string, suffix: string): string {
  return `${label} (${suffix})`;
}

const CREDIT_UNIT = { kind: "count", unit: "credit" } as const;
/** Credits carry six decimals; a difference of two would otherwise show binary noise past them. */
const CREDIT_DECIMALS = 6;

function amountOf(value: number, unit: Amount["unit"]): Amount {
  return { decimal: accountingDecimalFromNumber(value), unit };
}

function creditAmount(value: number): Amount {
  const factor = 10 ** CREDIT_DECIMALS;
  return amountOf(Math.round(value * factor) / factor, CREDIT_UNIT);
}

/**
 * One calendar month back, clamped to that month's last day: a cycle ends on the next month's
 * corresponding day at 23:59:59 (UTC+8), or on that month's last day when it has none.
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

function windowStartIso(window: QuotaWindow, resetsAt: string | undefined): string | undefined {
  if (resetsAt === undefined) return undefined;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return undefined;
  const lengthMs = WINDOWS[window].lengthMs;
  const startMs = lengthMs !== undefined ? resetMs - lengthMs : oneCalendarMonthBefore(resetMs);
  return new Date(startMs).toISOString();
}

/** The CLI's field names and the repo's slots for them. */
const TOKEN_PLAN_SLOTS = [
  ["per5Hour", FIVE_HOUR],
  ["per1Week", WEEKLY],
  ["per1Month", MONTHLY],
] as const;

/** The repo's slot for the CLI's window; a window the slots do not name takes the repo's window
 * for the CLI's own shape of it. */
function tokenPlanSlot(window: AlibabaTokenPlanWindow): Slot | undefined {
  const slot = TOKEN_PLAN_SLOTS.find(([key]) => key === window.key)?.[1];
  if (slot) return slot;
  const repoWindow = classifyWindow(`${window.count}-${window.unit}`);
  if (!repoWindow) return undefined;
  return { key: repoWindow, label: WINDOWS[repoWindow].label, window: repoWindow };
}

/** One row for each window the CLI reported a usage ratio for, in the shared row shape. */
function tokenPlanWindowRows(windows: readonly AlibabaTokenPlanWindow[]): ProviderRow[] {
  const slots = windows.flatMap((window): WindowRow[] => {
    const slot = tokenPlanSlot(window);
    if (!slot || window.percentRemaining === undefined) return [];
    // The CLI reports when the window refreshes; a billing month started a calendar month
    // before its reset.
    const startedAtIso = windowStartIso(slot.window, window.resetTimeIso);
    return [
      {
        // The row key names the half of the plan; the slot's key names the window.
        slot: { ...slot, key: `personal.${slot.key}` },
        value: {
          percentRemaining: window.percentRemaining,
          ...(window.resetTimeIso !== undefined ? { resetTimeIso: window.resetTimeIso } : {}),
          ...(startedAtIso !== undefined ? { fixedWindow: { startedAtIso } } : {}),
        },
      },
    ];
  });
  return windowRows(slots, "local_cli");
}

/** The windows the reply carried, the way the Coding Plan names them. */
function tokenPlanWindowsText(windows: readonly AlibabaTokenPlanWindow[]): string {
  const names = windows.flatMap((window) => {
    const slot = tokenPlanSlot(window);
    return slot ? [slot.key] : [];
  });
  return names.length > 0 ? names.join(",") : "(none)";
}

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
    // A seat's cycle is 30 days, not a calendar month, so the span needs the cycle's own start.
    ...(seat.startedAt !== undefined ? { windowStartedAt: seat.startedAt } : {}),
    ...(hasValue ? {} : { text: "no usage reported" }),
  };
}

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

const CODING_PLAN_LABEL = "Alibaba Coding Plan";

/** The quota is requests: the CLI counts requests, not credits or tokens. */
const REQUEST_UNIT = { kind: "count", unit: "request" } as const;

const WINDOW_SLOTS = [
  ["fiveHour", FIVE_HOUR],
  ["weekly", WEEKLY],
  ["monthly", MONTHLY],
] as const;

function codingPlanWindowRows(usage: AlibabaCodingPlanUsage): ProviderRow[] {
  const slots: WindowRow[] = WINDOW_SLOTS.flatMap(([name, slot]) => {
    const window = usage[name];
    if (!window) return [];
    // The CLI reports when the window refreshes; a billing month's start is a calendar month back.
    const startedAt = windowStartIso(slot.window, window.resetTimeIso);
    return [
      {
        slot,
        value: {
          percentRemaining: window.percentRemaining,
          used: amountOf(window.used, REQUEST_UNIT),
          limit: amountOf(window.limit, REQUEST_UNIT),
          ...(window.resetTimeIso !== undefined ? { resetTimeIso: window.resetTimeIso } : {}),
          ...(startedAt !== undefined ? { fixedWindow: { startedAtIso: startedAt } } : {}),
        },
      },
    ];
  });
  return windowRows(slots, "local_cli");
}

function codingPlanWindowsText(usage: AlibabaCodingPlanUsage | undefined): string {
  if (!usage) return "(none)";
  const keys = WINDOW_SLOTS.flatMap(([name, slot]) => (usage[name] ? [slot.key] : []));
  return keys.length > 0 ? keys.join(",") : "(none)";
}

/** The setup keys, reported once by the first command; any failure but a missing executable means it exists. */
function setupDetails(first: AlibabaCommandResult): DebugDetail[] {
  return statusDetailsFromRecord({
    cli_available: !first.ok && first.kind === "executable_not_found" ? "false" : "true",
    platform: process.platform,
  });
}

function commandDebug(results: readonly AlibabaCommandResult[]): DebugDetail[] {
  const [first] = results;
  if (!first) return [];
  return [
    ...setupDetails(first),
    ...(first.ok ? [] : [{ key: "failure_kind", value: first.kind }]),
    ...results.flatMap((result) => result.debug),
  ];
}

async function runAlibabaCommand(
  command: AlibabaCommand,
  options: AlibabaRunOptions,
): Promise<AlibabaCommandResult> {
  if (command.read) return await command.read(options);
  const reply = await queryAlibabaReply({
    args: command.args,
    kinds: command.kinds,
    ...options,
  });
  return reply.ok ? command.parse(reply.text) : failureResult(reply.error, []);
}

/**
 * The account the readings belong to: the access key id, which does not rotate. The console
 * token's mask is the fallback, but the CLI replaces that token when it expires.
 */
function alibabaAccountPrincipal(markers: AlibabaCredentialMarkers): ResolvedCredential | null {
  if (markers.openapiAccessKeyId) {
    return { credential: markers.openapiAccessKeyId, principalKind: "stable-id" };
  }
  if (markers.consoleMasked) {
    return { credential: markers.consoleMasked, principalKind: "credential" };
  }
  return null;
}

function alibabaRequestTimeoutMs(ctx: QuotaProviderContext): number | undefined {
  return ctx.config?.requestTimeoutMsConfigured ? ctx.config.requestTimeoutMs : undefined;
}

function createAlibabaProvider(spec: {
  id: CanonicalQuotaProviderId;
  label: string;
  /** The commands to run, in order. The first is the console one and owns the shared keys. */
  commands: readonly AlibabaCommand[];
}): QuotaProvider {
  const cachePolicy = resolvedCredentialPolicy(spec.id, async (ctx) => {
    const markers = await resolveAlibabaIdentity({
      requestTimeoutMs: alibabaRequestTimeoutMs(ctx),
      runtime: { cwd: ctx.workspaceRoot },
    });
    // No credential at all: there is no account to key a slot on.
    return markers ? alibabaAccountPrincipal(markers) : null;
  });

  return {
    id: spec.id,
    cachePolicy,

    // Never probes PATH: availability comes from selection or the current runtime identity.
    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      if (!isAlibabaTokenPlanSupportedPlatform()) return false;

      const selected = await isCanonicalProviderAvailable({
        ctx,
        providerId: spec.id,
        fallbackOnError: false,
      });
      if (selected || ctx.config.currentProviderID === spec.id) return true;
      const currentModel = ctx.config.currentModel;
      return !!currentModel && modelProviderMatchesRuntimeId(currentModel, spec.id);
    },

    matchesCurrentModel(model: string, context): boolean {
      if (context?.currentProviderID) {
        // Every accepted spelling normalises to this id, so `-cn` and `alibaba` match too.
        return normalizeQuotaProviderId(context.currentProviderID) === spec.id;
      }
      return modelProviderMatchesRuntimeId(model, spec.id);
    },

    async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
      const runtime = { cwd: ctx.workspaceRoot };
      const requestTimeoutMs = alibabaRequestTimeoutMs(ctx);
      // Independent commands with different auth: run them all, and let each report its own failure.
      const results = await Promise.all(
        spec.commands.map((command) => runAlibabaCommand(command, { runtime, requestTimeoutMs })),
      );
      // Read after the commands, so an account switched while they ran shows in the store's identity
      // re-check, which reuses this read.
      const markers = await resolveAlibabaIdentity({ requestTimeoutMs, runtime, fresh: true });
      const debug = commandDebug(results);
      const [first] = results;
      if (!first) return { attempted: false, accounts: [], debug };
      if (!first.ok && first.kind === "unsupported_platform") {
        return { attempted: false, accounts: [], debug };
      }

      // Gate here: an account with no rows and no errors is invisible to rows.ts, so nothing backs
      // off a capability the user lacks. Suppress a failure, never data; the marker can lag behind.
      const halves = alibabaCredentialHalves(markers);
      const accounts: AccountResult[] = [];
      for (const [index, result] of results.entries()) {
        const command = spec.commands[index];
        if (!command) continue;
        if (!halves[command.half] && !(result.ok && result.accounts.length > 0)) continue;
        if (result.ok) {
          accounts.push(...result.accounts);
        } else {
          accounts.push(
            failedAccount(command.failureAccount ?? spec.label, result.message, result.facts),
          );
        }
      }

      // Every command answered and none had anything to show, such as the Coding Plan's `{}`: an
      // answer, so it clears the last rows rather than reading as no data.
      const empty = accounts.length === 0 && results.every((result) => result.ok);
      return { attempted: true, accounts, debug, ...(empty ? { empty: true as const } : {}) };
    },
  };
}

const TOKEN_PLAN_COMMANDS: readonly AlibabaCommand[] = [
  {
    half: "console",
    args: ALIBABA_TOKEN_PLAN_ARGS,
    failureAccount: withSuffix(TOKEN_PLAN_LABEL, "personal"),
    kinds: USAGE_SPAWN_KINDS,
    parse(text: string): AlibabaCommandResult {
      const result: AlibabaTokenPlanClosedResult = parseAlibabaTokenPlanUsageJson(text);
      if (!result.ok) return failureResult(result.error, []);
      const rows = tokenPlanWindowRows(result.windows);
      // The CLI's own flag says whether a window carried a ratio; an older CLI sends none, and
      // then the windows say it.
      const noData =
        result.hasQuotaData === false ||
        result.windows.every((window) => window.percentRemaining === undefined);
      return {
        ok: true,
        accounts:
          rows.length > 0
            ? [
                {
                  name: withSuffix(TOKEN_PLAN_LABEL, "personal"),
                  rows,
                  errors: [],
                },
              ]
            : [],
        debug: statusDetailsFromRecord({
          windows: tokenPlanWindowsText(result.windows),
          window_hint: noData ? NO_QUOTA_DATA_HINT : undefined,
        }),
      };
    },
  },
  {
    half: "openapi",
    failureAccount: `${TOKEN_PLAN_LABEL} (team)`,
    async read(options: AlibabaRunOptions): Promise<AlibabaCommandResult> {
      // The lib owns the seat argv, so the command and the pages it reads cannot drift apart.
      const result: AlibabaTokenPlanSeatResult = await queryAlibabaTokenPlanSeats(options);
      if (!result.ok) {
        return failureResult(result.error, [
          { key: "seat_failure_kind", value: result.error.kind },
        ]);
      }
      const keys = seatKeys(result.seats);
      return {
        ok: true,
        accounts: result.seats.map((seat, index) => ({
          name: withSuffix(TOKEN_PLAN_LABEL, seat.name),
          rows: [seatRow(seat, keys[index] ?? "seat")],
          errors: [],
        })),
        debug: result.seats.length > 0 ? [{ key: "seat_windows", value: "credits" }] : [],
      };
    },
  },
];

export const alibabaTokenPlanProvider: QuotaProvider = createAlibabaProvider({
  id: "alibaba-token-plan",
  label: TOKEN_PLAN_LABEL,
  commands: TOKEN_PLAN_COMMANDS,
});

const CODING_PLAN_COMMANDS: readonly AlibabaCommand[] = [
  {
    half: "console",
    args: ["usage", "coding-plan", "--output", "json"],
    failureAccount: CODING_PLAN_LABEL,
    kinds: CODING_PLAN_SPAWN_KINDS,
    parse(text: string): AlibabaCommandResult {
      const result = parseAlibabaCodingPlanUsageJson(text);
      if (!result.ok) return failureResult(result.error, []);
      // `{}` is the CLI's "this account has no Coding Plan": an absence, not an error.
      return {
        ok: true,
        accounts: result.usage
          ? [
              {
                name: CODING_PLAN_LABEL,
                rows: codingPlanWindowRows(result.usage),
                errors: [],
              },
            ]
          : [],
        debug: statusDetailsFromRecord({ windows: codingPlanWindowsText(result.usage) }),
      };
    },
  },
];

export const alibabaCodingPlanProvider: QuotaProvider = createAlibabaProvider({
  id: "alibaba-coding-plan",
  label: CODING_PLAN_LABEL,
  commands: CODING_PLAN_COMMANDS,
});
