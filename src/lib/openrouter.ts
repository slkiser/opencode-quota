// Fork adaptation of adee036 / 81244a9: typed rows, safe diagnostics and frozen auth.
import type { AccountingDocument, AccountingRow } from "./accounting.js";
import { accountingQuantityFromNumber } from "./accounting.js";
import { fetchWithTimeout } from "./http.js";
import { createHash } from "node:crypto";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function base(id: string, name: string, resultType: AccountingRow["resultType"]): AccountingRow {
  return {
    id,
    name,
    resultType,
    prominence: "primary",
    source: {
      id: "openrouter",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    account: { kind: "unknown" },
    freshness: { kind: "unknown" },
    window: { kind: "unknown" },
    value: { kind: "status", status: "unknown" },
  };
}
const usd = (n: number) => accountingQuantityFromNumber(n, { kind: "currency", code: "USD" })!;
function budget(
  id: string,
  name: string,
  total: unknown,
  remaining: unknown,
  used: unknown,
): AccountingRow {
  const row = base(id, name, "budget");
  if (total === null) row.value = { kind: "status", status: "unlimited" };
  else if (
    finite(total) &&
    total > 0 &&
    finite(remaining) &&
    Number.isFinite((remaining / total) * 100)
  )
    row.value = {
      kind: "percent",
      remaining: (remaining / total) * 100,
      basis: {
        limit: { quantity: usd(total), authority: "provider_reported" },
        remaining: { quantity: usd(remaining), authority: "provider_reported" },
        ...(finite(used) && used >= 0
          ? { used: { quantity: usd(used), authority: "provider_reported" as const } }
          : {}),
      },
    };
  else if (finite(remaining)) row.value = { kind: "quantity", quantity: usd(remaining) };
  return row;
}
/** Never interpret lifetime usage as current-period usage or account balance. */
export function parseOpenRouterAccounting(payload: unknown): {
  accounting: AccountingDocument;
  warnings: string[];
} {
  if (!record(payload) || !record(payload.data))
    throw new Error("Invalid OpenRouter quota response");
  const data = payload.data,
    rows: AccountingRow[] = [],
    warnings: string[] = [];
  const cap = budget(
    "key-limit",
    "OpenRouter key cap",
    data.limit,
    data.limit_remaining,
    undefined,
  );
  if (
    typeof data.limit_reset === "string" &&
    ["daily", "weekly", "monthly"].includes(data.limit_reset)
  )
    cap.window = { kind: "identified", id: `key-${data.limit_reset}` };
  rows.push(cap);
  for (const [field, label] of [
    ["usage", "All-time spend"],
    ["usage_daily", "UTC day spend"],
    ["usage_weekly", "UTC week spend"],
    ["usage_monthly", "UTC month spend"],
    ["byok_usage", "All-time BYOK spend"],
  ] as const) {
    if (data[field] === undefined) continue;
    if (!finite(data[field]) || data[field] < 0) {
      warnings.push(`OpenRouter ${label.toLowerCase()} unavailable`);
      continue;
    }
    rows.push({
      ...base(field, `OpenRouter ${label}`, "spend"),
      prominence: "supplementary",
      value: { kind: "quantity", quantity: usd(data[field]) },
    });
  }
  const scopes = [
    "workspace_default_member",
    "workspace_default_key",
    "member",
    "api_key",
    "workspace",
    "key_limit",
  ];
  if (data.budgets !== undefined && !Array.isArray(data.budgets))
    warnings.push("OpenRouter budgets unavailable");
  if (Array.isArray(data.budgets)) {
    if (data.budgets.length > 64) warnings.push("OpenRouter budget list truncated");
    for (const [index, item] of data.budgets.slice(0, 64).entries()) {
      if (
        !record(item) ||
        !scopes.includes(String(item.scope)) ||
        !finite(item.limit_usd) ||
        item.limit_usd < 0 ||
        !finite(item.remaining_usd) ||
        !finite(item.spend_usd) ||
        item.spend_usd < 0
      ) {
        warnings.push("OpenRouter budget row unavailable");
        continue;
      }
      const identity = createHash("sha256")
        .update(
          JSON.stringify([
            item.scope,
            item.budget_id ?? null,
            item.guardrail_id ?? null,
            item.reset_interval ?? null,
            index,
          ]),
        )
        .digest("hex")
        .slice(0, 24);
      const row = budget(
        `budget-${identity}`,
        `OpenRouter ${item.scope} budget`,
        item.limit_usd,
        item.remaining_usd,
        item.spend_usd,
      );
      const reset =
        typeof item.resets_at === "string" && Number.isFinite(Date.parse(item.resets_at))
          ? new Date(item.resets_at).toISOString()
          : undefined;
      row.window = {
        kind: "identified",
        id: `budget-${identity}`,
        ...(reset ? { resetTimeIso: reset } : {}),
      };
      rows.push(row);
    }
  }
  if (record(data.free_model_daily_requests)) {
    const free = data.free_model_daily_requests;
    if (
      finite(free.limit) &&
      free.limit > 0 &&
      finite(free.remaining) &&
      Number.isFinite((free.remaining / free.limit) * 100)
    )
      rows.push({
        ...base("free-daily", "OpenRouter free daily requests", "rate_limit"),
        window: { kind: "identified", id: "free-daily" },
        value: {
          kind: "percent",
          remaining: (free.remaining / free.limit) * 100,
          basis: {
            limit: {
              quantity: accountingQuantityFromNumber(free.limit, {
                kind: "count",
                unit: "request",
              })!,
              authority: "provider_reported",
            },
            remaining: {
              quantity: accountingQuantityFromNumber(free.remaining, {
                kind: "count",
                unit: "request",
              })!,
              authority: "provider_reported",
            },
          },
        },
      });
    else warnings.push("OpenRouter free request quota unavailable");
  }
  return { accounting: { version: 1, rows }, warnings: [...new Set(warnings)] };
}
export async function queryOpenRouterQuota(
  key: string,
  requestTimeoutMs?: number,
): Promise<
  | { success: true; accounting: AccountingDocument; warnings: string[] }
  | { success: false; error: string }
> {
  try {
    const response = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/key",
      {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      },
      requestTimeoutMs,
    );
    if (!response.ok) return { success: false, error: `OpenRouter quota HTTP ${response.status}` };
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Response too large");
    return { success: true, ...parseOpenRouterAccounting(JSON.parse(text)) };
  } catch {
    return {
      success: false,
      error: "OpenRouter quota unavailable (transport, timeout or invalid response)",
    };
  }
}
