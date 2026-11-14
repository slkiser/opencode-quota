/** Claude Console prepaid credits, using only an explicitly supplied session cookie. */
import type { ErrorFacts } from "../core/errors.js";
import type { Amount } from "../core/types.js";
import { failureFacts, requestJson } from "./http.js";
import { isRecord } from "./json-guards.js";

export const CONSOLE_COOKIE_ENV = "ANTHROPIC_CONSOLE_COOKIE";
export const CONSOLE_ORGANIZATION_ENV = "ANTHROPIC_CONSOLE_ORGANIZATION";
const ORIGIN = "https://platform.claude.com";

type ConsoleConfig =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "configured"; cookie: string; organization?: string };

/** As with MiMo, retain only the required cookie and reject line breaks and duplicates. */
export function resolveAnthropicConsoleConfig(): ConsoleConfig {
  const raw = process.env[CONSOLE_COOKIE_ENV];
  if (raw === undefined) return { state: "none" };
  if ([...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    return { state: "invalid" };
  const header = raw.trim().replace(/^cookie\s*:\s*/iu, "");
  const pairs = header.includes("=") ? header.split(";") : [`sessionKey=${header}`];
  let sessionKey: string | undefined;
  for (const part of pairs) {
    if (!part.trim()) continue;
    const separator = part.indexOf("=");
    if (separator < 1) return { state: "invalid" };
    if (part.slice(0, separator).trim() !== "sessionKey") continue;
    const value = part.slice(separator + 1).trim();
    if (!value || sessionKey !== undefined || /[\s",\\]/u.test(value)) return { state: "invalid" };
    sessionKey = value;
  }
  if (!sessionKey) return { state: "invalid" };
  const organization = process.env[CONSOLE_ORGANIZATION_ENV]?.trim();
  return {
    state: "configured",
    cookie: `sessionKey=${sessionKey}`,
    ...(organization ? { organization } : {}),
  };
}

type ConsoleResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; facts: ErrorFacts };

async function consoleRequest(
  path: string,
  cookie: string,
  requestTimeoutMs?: number,
): Promise<ConsoleResult<unknown>> {
  const reply = await requestJson(`${ORIGIN}${path}`, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/settings/billing`,
    },
    secrets: [cookie, cookie.slice("sessionKey=".length)],
    timeoutMs: requestTimeoutMs ?? 10_000,
    maxBytes: 256 * 1024,
  });
  if (reply.ok) return { success: true, data: reply.json };
  const { failure } = reply;
  const status = failure.status;
  if (
    status === 401 ||
    (path === "/api/organizations" && status === 403) ||
    (status !== undefined && status >= 300 && status < 400)
  ) {
    return {
      success: false,
      error: `Claude Console session expired; update ${CONSOLE_COOKIE_ENV}`,
      facts: failureFacts(failure, "login_expired"),
    };
  }
  if (status === 403) {
    return {
      success: false,
      error: "Claude Console billing access denied; ask the organization owner for billing access",
      facts: failureFacts(failure),
    };
  }
  // Never echo provider bodies or transport messages: either can contain the cookie.
  return {
    success: false,
    error:
      status === undefined
        ? "Claude Console request failed"
        : `Claude Console request failed (HTTP ${status})`,
    facts: failureFacts(failure),
  };
}

/** Shift integer minor units as text, keeping zero and every reported fractional digit. */
function prepaidAmount(json: unknown): Amount | undefined {
  if (!isRecord(json)) return undefined;
  const currency = typeof json.currency === "string" ? json.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/u.test(currency)) return undefined;
  let exponent: unknown = 2;
  if (json.balance != null) {
    if (!isRecord(json.balance)) return undefined;
    if (json.balance.credits != null) {
      if (!isRecord(json.balance.credits)) return undefined;
      exponent = json.balance.credits.exponent ?? 2;
    }
  }
  if (typeof exponent !== "number" || !Number.isInteger(exponent) || exponent < 0 || exponent > 4)
    return undefined;
  const minor =
    typeof json.amount === "number" && Number.isSafeInteger(json.amount)
      ? String(json.amount)
      : json.amount;
  if (typeof minor !== "string" || !/^-?(?:0|[1-9]\d*)$/u.test(minor)) return undefined;
  const sign = minor.startsWith("-") ? "-" : "";
  const digits = minor.replace(/^-/u, "").padStart(exponent + 1, "0");
  const decimal =
    exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return {
    decimal: /^0(?:\.0+)?$/u.test(decimal) ? decimal : `${sign}${decimal}`,
    unit: { kind: "currency", code: currency },
  };
}

export async function queryAnthropicConsoleCredits(
  config: Extract<ConsoleConfig, { state: "configured" }>,
  requestTimeoutMs?: number,
): Promise<ConsoleResult<Amount | undefined>> {
  const organizations = await consoleRequest("/api/organizations", config.cookie, requestTimeoutMs);
  if (!organizations.success) return organizations;
  const badResponse = {
    success: false,
    error: "Claude Console organizations response did not match the expected schema",
    facts: { code: "bad_response" },
  } as const;
  if (!Array.isArray(organizations.data)) return badResponse;
  const candidates: { id: string; name?: string }[] = [];
  for (const organization of organizations.data) {
    if (!isRecord(organization)) return badResponse;
    if (!Array.isArray(organization.capabilities) || !organization.capabilities.includes("api"))
      continue;
    if (typeof organization.uuid !== "string" || !/^[A-Za-z0-9-]{1,64}$/u.test(organization.uuid))
      return badResponse;
    candidates.push({
      id: organization.uuid,
      ...(typeof organization.name === "string" ? { name: organization.name } : {}),
    });
  }
  if (candidates.length === 0) {
    return {
      success: false,
      error: "No Claude Console API organization found for this session",
      facts: { code: "no_plan" },
    };
  }
  const selected = config.organization
    ? candidates.filter(
        (candidate) =>
          candidate.id === config.organization || candidate.name === config.organization,
      )
    : candidates;
  if (selected.length !== 1) {
    return {
      success: false,
      error: `Set ${CONSOLE_ORGANIZATION_ENV} to one accessible Claude Console API organization name or UUID`,
      facts: { code: "not_configured" },
    };
  }
  const credits = await consoleRequest(
    `/api/organizations/${selected[0]!.id}/prepaid/credits`,
    config.cookie,
    requestTimeoutMs,
  );
  return credits.success ? { success: true, data: prepaidAmount(credits.data) } : credits;
}
