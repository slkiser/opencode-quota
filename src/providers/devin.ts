/**
 * Devin: the daily and weekly quota of each OpenCode Devin sign-in, the one Devin Desktop's usage
 * meter shows. OpenCode has no Devin login of its own: the sign-in is the session token a Devin
 * plugin's `/connect` stores under the `devin` integration.
 *
 * Devin documents no quota API. This asks the endpoint its own clients use
 * (POST <api server>/exa.seat_management_pb.SeatManagementService/GetUserStatus, Connect over
 * protobuf) and reads the few fields below by number, so a change on Devin's side can break it.
 */

import type { ErrorFacts } from "../core/errors.js";
import { secretValuesRedactor } from "../core/redact.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
} from "../lib/entries.js";
import { errorWords, fetchWithTimeout } from "../lib/http.js";
import { isRecord, nonEmptyString } from "../lib/json-guards.js";
import { type CredentialRow, readCredentialRows, readOAuthLogin } from "../lib/opencode-auth.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  deriveResolvedAuthIdentity,
  loginListIdentity,
  type ResolvedAuthIdentity,
} from "../lib/resolved-auth-identity.js";
import {
  type FetchError,
  fetchEachLogin,
  fetchError,
  type ProviderFetchResult,
  type ProviderRow,
  type Slot,
  WEEKLY,
  windowRows,
  type WindowValue,
} from "./contract.js";

const DEFAULT_API_SERVER = "https://server.codeium.com";
const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
/** What a Devin session token starts with; any other stored value is not one. */
const TOKEN_PREFIX = "devin-session-token$";
const CLIENT_NAME = "windsurf";
const CLIENT_VERSION = "2.0.0";
/** The reply also lists every model of the account, about 150 KiB. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const MAX_UNIX_SECONDS = 253_402_300_799n;

const DAILY: Slot = { key: "daily", label: "Daily", window: "day" };

/** Field numbers of the reply: user status → plan status → plan info. */
const USER_STATUS = 1;
const TEAM_ID = 5;
const EMAIL = 7;
const PLAN_STATUS = 13;
const PLAN_INFO = 1;
const PLAN_NAME = 2;
const DAILY_PERCENT_LEFT = 14;
const WEEKLY_PERCENT_LEFT = 15;
const DAILY_RESET_UNIX = 17;
const WEEKLY_RESET_UNIX = 18;

type ResolvedDevinLogin =
  | { state: "none" }
  | { state: "failed"; error: string }
  | { state: "configured"; token: string; apiServer: string };

type DevinLogin = {
  row: CredentialRow;
  auth: Exclude<ResolvedDevinLogin, { state: "none" }>;
};

type DevinLoginFetch = {
  rows: ProviderRow[];
  errors: FetchError[];
  fallbackName?: string;
  /** Whose quota this is (never shown): two sign-ins of one account share it. */
  accountKey?: string;
};

/** The tenant's own API server a login names, when it is a plain HTTPS origin; else the default. */
function apiServerOf(fields: Readonly<Record<string, unknown>>): string {
  const stored = isRecord(fields.metadata) ? nonEmptyString(fields.metadata.apiServerUrl) : "";
  if (!stored) return DEFAULT_API_SERVER;
  try {
    const url = new URL(stored);
    const plain = !url.username && !url.password && !url.search && !url.hash;
    if (url.protocol === "https:" && plain && url.pathname === "/") return url.origin;
  } catch {
    // Not a URL: the default server answers for every account without a tenant server.
  }
  return DEFAULT_API_SERVER;
}

function resolveDevinLogin(row: CredentialRow): ResolvedDevinLogin {
  const login = readOAuthLogin(row);
  if (!login) return { state: "none" };
  if (login.state === "failed") return { state: "failed", error: login.error };
  if (!login.accessToken?.startsWith(TOKEN_PREFIX)) return { state: "none" };
  return { state: "configured", token: login.accessToken, apiServer: apiServerOf(login.fields) };
}

/** Every OpenCode Devin sign-in; one OpenCode could not return stays, to show as its own error. */
async function readDevinLogins(): Promise<DevinLogin[]> {
  return (await readCredentialRows(["devin"], { methods: ["oauth"] })).flatMap((row) => {
    const auth = resolveDevinLogin(row);
    return auth.state === "none" ? [] : [{ row, auth }];
  });
}

/** Who Devin is signed in as: every sign-in's session token and the server it asks. */
async function devinLoginsIdentity(
  logins: readonly DevinLogin[],
): Promise<ResolvedAuthIdentity | null> {
  return loginListIdentity(
    "devin",
    await Promise.all(
      logins.map(async ({ row, auth }) => ({
        identity:
          auth.state === "configured"
            ? await deriveResolvedAuthIdentity({
                providerId: "devin",
                principal: { kind: "credential", value: auth.token },
                qualifiers: [auth.apiServer],
              })
            : null,
        row,
      })),
    ),
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varint(value: number | bigint): Uint8Array {
  const bytes: number[] = [];
  let rest = BigInt(value);
  while (rest > 127n) {
    bytes.push(Number(rest & 127n) | 128);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Uint8Array.from(bytes);
}

function varintField(number: number, value: number | bigint): Uint8Array {
  return concat([varint(number << 3), varint(value)]);
}

function bytesField(number: number, body: Uint8Array): Uint8Array {
  return concat([varint((number << 3) | 2), varint(body.length), body]);
}

function textField(number: number, text: string): Uint8Array {
  return bytesField(number, new TextEncoder().encode(text));
}

/** The request: the client metadata Devin's servers expect, with the session token in it. */
function userStatusRequest(token: string, nowMs: number): Uint8Array<ArrayBuffer> {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return concat([
    bytesField(
      1,
      concat([
        textField(1, CLIENT_NAME),
        textField(2, CLIENT_VERSION),
        textField(3, token),
        textField(4, "en"),
        textField(5, os),
        textField(7, CLIENT_VERSION),
        varintField(9, nowMs),
        textField(10, crypto.randomUUID()),
        textField(12, CLIENT_NAME),
        bytesField(16, varintField(1, Math.floor(nowMs / 1000))),
        textField(25, crypto.randomUUID()),
        textField(26, "Unset"),
        textField(28, CLIENT_NAME),
      ]),
    ),
  ]);
}

type ProtoField = { number: number; value: bigint | Uint8Array };

/** The fields of one protobuf message; fixed-width values are skipped. Throws when it is cut. */
function readFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  const readVarint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined) break;
      value |= BigInt(byte & 127) << shift;
      if ((byte & 128) === 0) return value;
    }
    throw new Error("Devin returned an unreadable response");
  };
  const take = (length: number): Uint8Array => {
    if (length > bytes.length - offset) throw new Error("Devin returned an unreadable response");
    offset += length;
    return bytes.subarray(offset - length, offset);
  };
  while (offset < bytes.length) {
    const tag = readVarint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (number === 0) throw new Error("Devin returned an unreadable response");
    if (wire === 0) fields.push({ number, value: readVarint() });
    else if (wire === 2) fields.push({ number, value: take(Number(readVarint())) });
    else if (wire === 1) take(8);
    else if (wire === 5) take(4);
    else throw new Error("Devin returned an unreadable response");
  }
  return fields;
}

/** A field's value; when it is sent more than once, the last one counts. */
function fieldValue(
  fields: readonly ProtoField[],
  number: number,
): ProtoField["value"] | undefined {
  return fields.filter((field) => field.number === number).at(-1)?.value;
}

function messageField(fields: readonly ProtoField[], number: number): ProtoField[] | undefined {
  const value = fieldValue(fields, number);
  return value instanceof Uint8Array ? readFields(value) : undefined;
}

function numberField(fields: readonly ProtoField[], number: number): bigint | undefined {
  const value = fieldValue(fields, number);
  return typeof value === "bigint" ? value : undefined;
}

/**
 * One window from its percent left and its reset time. Protobuf leaves a zero out, so a window
 * with a reset time and no percent is used up; a window with neither is not part of the plan.
 */
function windowValue(
  percentLeft: bigint | undefined,
  resetUnix: bigint | undefined,
  name: string,
): WindowValue | undefined {
  if (percentLeft === undefined && resetUnix === undefined) return undefined;
  if (percentLeft !== undefined && percentLeft > 100n) {
    throw new Error(`Devin returned an invalid ${name} percentage`);
  }
  if (resetUnix !== undefined && (resetUnix === 0n || resetUnix > MAX_UNIX_SECONDS)) {
    throw new Error(`Devin returned an invalid ${name} reset time`);
  }
  return {
    percentRemaining: Number(percentLeft ?? 0n),
    ...(resetUnix === undefined
      ? {}
      : { resetTimeIso: new Date(Number(resetUnix) * 1000).toISOString() }),
  };
}

/** The plan name and its windows. Devin Max has a weekly quota only, so its daily one is left out. */
function parseUserStatus(bytes: Uint8Array): {
  plan?: string;
  accountKey?: string;
  rows: ProviderRow[];
} {
  const userStatus = messageField(readFields(bytes), USER_STATUS) ?? [];
  const planStatus = messageField(userStatus, PLAN_STATUS);
  if (!planStatus) return { rows: [] };

  const nameBytes = fieldValue(messageField(planStatus, PLAN_INFO) ?? [], PLAN_NAME);
  const plan =
    nameBytes instanceof Uint8Array
      ? sanitizeSingleLineDisplaySnippet(new TextDecoder().decode(nameBytes), 40).trim()
      : "";
  const hasDailyQuota = plan.toLowerCase() !== "max";
  const rows = windowRows([
    {
      slot: DAILY,
      value: hasDailyQuota
        ? windowValue(
            numberField(planStatus, DAILY_PERCENT_LEFT),
            numberField(planStatus, DAILY_RESET_UNIX),
            "daily",
          )
        : undefined,
    },
    {
      slot: WEEKLY,
      value: windowValue(
        numberField(planStatus, WEEKLY_PERCENT_LEFT),
        numberField(planStatus, WEEKLY_RESET_UNIX),
        "weekly",
      ),
    },
  ]);
  const account = [TEAM_ID, EMAIL].map((number) => {
    const value = fieldValue(userStatus, number);
    return value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
  });
  return {
    ...(plan ? { plan } : {}),
    ...(account.some(Boolean) ? { accountKey: JSON.stringify(account) } : {}),
    rows,
  };
}

function failedLogin(message: string, facts?: ErrorFacts): DevinLoginFetch {
  return { rows: [], errors: [fetchError(message, facts)] };
}

async function readReplyBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REPLY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Devin returned a response that is too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_REPLY_BYTES)
    throw new Error("Devin returned a response that is too large");
  return bytes;
}

/** The quota rows of one sign-in, named after its plan. */
async function queryDevinLogin(
  auth: DevinLogin["auth"],
  requestTimeoutMs?: number,
): Promise<DevinLoginFetch> {
  if (auth.state === "failed") {
    return failedLogin(`Devin sign-in could not be read: ${auth.error}. Reconnect Devin.`);
  }
  const safe = (text: string) =>
    sanitizeSingleLineDisplaySnippet(secretValuesRedactor([auth.token])(text), 160);

  try {
    return await fetchWithTimeout(`${auth.apiServer}${USER_STATUS_PATH}`, {
      request: {
        method: "POST",
        headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
        body: userStatusRequest(auth.token, Date.now()),
        redirect: "error",
      },
      timeoutMs: requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const words = await response.text().catch(() => "");
          const loginExpired = response.status === 401 || response.status === 403;
          return failedLogin(`Devin API error ${response.status}${errorWords(safe(words))}`, {
            code: loginExpired
              ? "login_expired"
              : response.status === 429
                ? "rate_limited"
                : "provider_error",
            status: response.status,
          });
        }
        const { plan, accountKey, rows } = parseUserStatus(await readReplyBytes(response));
        const account = accountKey ? { accountKey } : {};
        if (rows.length === 0) {
          return { ...failedLogin("No quota data", { code: "no_data" }), ...account };
        }
        return {
          rows,
          errors: [],
          ...(plan ? { fallbackName: `Devin (${plan})` } : {}),
          ...account,
        };
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const facts: ErrorFacts | undefined = message.startsWith("Request timeout")
      ? { code: "timeout" }
      : message.startsWith("Devin returned")
        ? { code: "bad_response" }
        : { code: "network" };
    return failedLogin(safe(message), facts);
  }
}

export const devinProvider: QuotaProvider = {
  id: "devin",
  cachePolicy: {
    kind: "resolved-auth",
    resolveIdentity: async () => devinLoginsIdentity(await readDevinLogins()),
  },

  async isAvailable(): Promise<boolean> {
    return (await readDevinLogins()).length > 0;
  },

  matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID.trim().toLowerCase() === "devin";
    }
    return modelProviderMatchesRuntimeId(model, "devin");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    const logins = await readDevinLogins();
    const fetched = await Promise.all(
      logins.map(({ auth }) => queryDevinLogin(auth, requestTimeoutMs)),
    );
    // Connecting Devin again stores another sign-in of the same account: its quota shows once,
    // from the first sign-in (logins come with the one OpenCode uses first).
    const seen = new Set<string>();
    const answers = new Map<DevinLogin, DevinLoginFetch>();
    logins.forEach((login, index) => {
      const { accountKey, ...answer } = fetched[index] as DevinLoginFetch;
      if (accountKey !== undefined && seen.has(accountKey)) return;
      if (accountKey !== undefined) seen.add(accountKey);
      answers.set(login, answer);
    });
    const accounts = await fetchEachLogin({
      providerName: "Devin",
      logins: [...answers.keys()],
      fetchLogin: async (login) => answers.get(login) ?? null,
    });
    return { attempted: logins.length > 0, accounts, debug: [] };
  },
};
