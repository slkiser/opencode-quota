/**
 * The plugin RPC between OpenCode Quota's server plugin and its clients. The server
 * registers it in its setup and computes quota there; clients call it by this definition.
 * Imports from `@opencode/*` and `./core/*` stay type-only, so loading this file loads no
 * OpenCode package and no server code.
 *
 * Methods: `snapshot` (the last known quota, instantly), `refresh`, `notices` (the Home
 * notice line), `noticeList` (the active maintainer notices), `status` (the /quota_status report),
 * `usage` (tokens and cost from OpenCode's history for one range),
 * `downloadPrices` (a new price list from models.dev), `settings` (the server settings a client
 * may change), `saveSettings` (a patch of the server settings file, and custom provider
 * switches); the
 * `changed` event carries every new snapshot.
 */
import type { Rpc } from "@opencode/plugin";
import type { QuotaSnapshot } from "./core/types.js";
import type { UsageQuery, UsageRange, UsageReport } from "./core/usage.js";
import { parseCalendarDate } from "./lib/calendar-date.js";
import { isRecord } from "./lib/json-guards.js";
import type { ClientSettings, CustomSwitch, SettingsIssue } from "./settings/index.js";

export const QUOTA_RPC_ID = "slkiser.opencode-quota";

export type QuotaRpcSnapshotInput = { sessionID?: string };
export type QuotaRpcRefreshReason = "poll" | "turn" | "manual";
export type QuotaRpcRefreshInput = {
  reason: QuotaRpcRefreshReason;
  providerIds?: string[];
  sessionID?: string;
};
/** Answer of `snapshot` and `refresh`, and the data of the `changed` event. */
export type QuotaRpcSnapshotOutput = { snapshot: QuotaSnapshot };
export type QuotaRpcNoticesInput = Record<string, never>;
/** The maintainer notice line for the bottom of Home; "" when there is none to show now. */
export type QuotaRpcNoticesOutput = { homeLine: string };
/** The /quota_status report as text; with a session, it also checks that session's model. */
export type QuotaRpcStatusInput = { sessionID?: string };
export type QuotaRpcStatusOutput = { text: string };
export type Notice = { id: string; message: string; url?: string };
export type QuotaRpcNoticeListInput = Record<string, never>;
/** The active maintainer notices for the providers quota shows. */
export type QuotaRpcNoticeListOutput = { notices: Notice[] };
export type QuotaRpcUsageInput = UsageQuery;
export type QuotaRpcUsageOutput = { report: UsageReport };
export type QuotaRpcDownloadPricesInput = Record<string, never>;
/** `message` says what happened, for a toast. */
export type QuotaRpcDownloadPricesOutput = { ok: boolean; message: string };
export type QuotaRpcSettingsInput = Record<string, never>;
export type QuotaRpcSettingsOutput = ClientSettings;
/**
 * A JSON merge patch of settings.jsonc; file-only keys are refused. `customEnabled` switches
 * custom providers on or off by id: the user's switch in the quota window's Providers tab, with
 * the fingerprint of the definition the tab showed.
 */
export type QuotaRpcSaveSettingsInput = {
  patch: Record<string, unknown>;
  customEnabled?: Record<string, CustomSwitch>;
};
/** Nothing is saved unless `ok`; `issues` say why. */
export type QuotaRpcSaveSettingsOutput = { ok: boolean; issues: SettingsIssue[] };
type StandardValueSchema = Extract<Rpc.PortableValueSchema, { "~standard": unknown }>;
type StandardEventSchema = Extract<Rpc.PortableEventDefinition["schema"], { "~standard": unknown }>;
type Typed<T> = { "~standard": { types?: { input: T; output: T } } };
type QuotaRpcSchema<T> = StandardValueSchema & Typed<T>;
type QuotaRpcEventSchema<T> = StandardEventSchema & Typed<T>;

/**
 * A Standard Schema that runs `check` and passes the value through unchanged. OpenCode
 * validates every input and output with it. `types` only carries T for TypeScript.
 */
function schema<T>(check: (value: unknown) => string | null): QuotaRpcSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-quota",
      validate: (value) => {
        const issue = check(value);
        return issue ? { issues: [{ message: issue }] } : { value: value as T };
      },
    },
  };
}

/** The same for event data, which OpenCode requires to be an object. */
function eventSchema<T extends Readonly<Record<string, unknown>>>(
  check: (value: unknown) => string | null,
): QuotaRpcEventSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-quota",
      validate: (value) => {
        const issue = check(value);
        return issue ? { issues: [{ message: issue }] } : { value: value as T };
      },
    },
  };
}

/** An input with no fields of its own. */
function checkObjectInput(value: unknown): string | null {
  return isRecord(value) ? null : "input must be an object";
}

/** An input whose only field is an optional session id. */
function checkSessionInput(value: unknown): string | null {
  return isRecord(value) ? checkOptionalString(value, "sessionID") : "input must be an object";
}

function checkOptionalString(input: Record<string, unknown>, field: string): string | null {
  return input[field] === undefined || typeof input[field] === "string"
    ? null
    : `${field} must be a string`;
}

function checkOptionalStringList(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  return value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ? null
    : `${field} must be a list of strings`;
}

function checkSnapshotOutput(value: unknown): string | null {
  return isRecord(value) && isRecord(value.snapshot) ? null : "output must carry a snapshot";
}

const REFRESH_REASONS: readonly QuotaRpcRefreshReason[] = ["poll", "turn", "manual"];
/** What each usage range needs besides itself. */
const USAGE_RANGE_NEEDS: Record<UsageRange, "nothing" | "sessionID" | "dates"> = {
  today: "nothing",
  "24h": "nothing",
  "7d": "nothing",
  "30d": "nothing",
  "90d": "nothing",
  all: "nothing",
  session: "sessionID",
  between: "dates",
};

function checkUsageInput(value: unknown): string | null {
  if (!isRecord(value)) return "input must be an object";
  const range = value.range;
  if (typeof range !== "string" || !Object.hasOwn(USAGE_RANGE_NEEDS, range)) {
    return `range must be one of ${Object.keys(USAGE_RANGE_NEEDS).join(", ")}`;
  }
  const typeIssue =
    checkOptionalString(value, "sessionID") ??
    checkOptionalString(value, "from") ??
    checkOptionalString(value, "to");
  if (typeIssue) return typeIssue;
  const needs = USAGE_RANGE_NEEDS[range as UsageRange];
  if (needs === "sessionID" && !value.sessionID) return `sessionID is required for range ${range}`;
  if (needs !== "dates") return null;
  for (const field of ["from", "to"]) {
    if (!parseCalendarDate(value[field])) return `${field} must be a date like 2026-01-31`;
  }
  return (value.from as string) > (value.to as string) ? "to must not be before from" : null;
}

export const QuotaRpc = {
  id: QUOTA_RPC_ID,
  events: {
    changed: { schema: eventSchema<QuotaRpcSnapshotOutput>(checkSnapshotOutput) },
  },
  methods: {
    snapshot: {
      input: schema<QuotaRpcSnapshotInput>(checkSessionInput),
      output: schema<QuotaRpcSnapshotOutput>(checkSnapshotOutput),
    },
    refresh: {
      input: schema<QuotaRpcRefreshInput>((value) => {
        if (!isRecord(value)) return "input must be an object";
        if (!REFRESH_REASONS.includes(value.reason as QuotaRpcRefreshReason)) {
          return `reason must be one of ${REFRESH_REASONS.join(", ")}`;
        }
        return (
          checkOptionalStringList(value, "providerIds") ?? checkOptionalString(value, "sessionID")
        );
      }),
      output: schema<QuotaRpcSnapshotOutput>(checkSnapshotOutput),
    },
    notices: {
      input: schema<QuotaRpcNoticesInput>(checkObjectInput),
      output: schema<QuotaRpcNoticesOutput>((value) =>
        isRecord(value) && typeof value.homeLine === "string"
          ? null
          : "output must carry a homeLine string",
      ),
    },
    noticeList: {
      input: schema<QuotaRpcNoticeListInput>(checkObjectInput),
      output: schema<QuotaRpcNoticeListOutput>((value) =>
        isRecord(value) && Array.isArray(value.notices) ? null : "output must carry notices",
      ),
    },
    status: {
      input: schema<QuotaRpcStatusInput>(checkSessionInput),
      output: schema<QuotaRpcStatusOutput>((value) =>
        isRecord(value) && typeof value.text === "string" ? null : "output must carry a text",
      ),
    },
    usage: {
      input: schema<QuotaRpcUsageInput>(checkUsageInput),
      output: schema<QuotaRpcUsageOutput>((value) =>
        isRecord(value) && isRecord(value.report) ? null : "output must carry a report",
      ),
    },
    downloadPrices: {
      input: schema<QuotaRpcDownloadPricesInput>(checkObjectInput),
      output: schema<QuotaRpcDownloadPricesOutput>((value) =>
        isRecord(value) && typeof value.ok === "boolean" && typeof value.message === "string"
          ? null
          : "output must carry ok and a message",
      ),
    },
    settings: {
      input: schema<QuotaRpcSettingsInput>(checkObjectInput),
      output: schema<QuotaRpcSettingsOutput>((value) =>
        isRecord(value) &&
        isRecord(value.values) &&
        Array.isArray(value.fromFile) &&
        Array.isArray(value.providers) &&
        Array.isArray(value.custom)
          ? null
          : "output must carry values, fromFile, providers and custom",
      ),
    },
    saveSettings: {
      input: schema<QuotaRpcSaveSettingsInput>((value) => {
        if (!isRecord(value) || !isRecord(value.patch)) return "input must carry a patch object";
        const switches = value.customEnabled;
        if (switches === undefined) return null;
        return isRecord(switches) &&
          Object.values(switches).every(
            (item) =>
              isRecord(item) &&
              typeof item.enabled === "boolean" &&
              typeof item.fingerprint === "string",
          )
          ? null
          : "customEnabled must map provider ids to { enabled, fingerprint }";
      }),
      output: schema<QuotaRpcSaveSettingsOutput>((value) =>
        isRecord(value) && typeof value.ok === "boolean" && Array.isArray(value.issues)
          ? null
          : "output must carry ok and issues",
      ),
    },
  },
} satisfies Rpc.PortableDefinition;
