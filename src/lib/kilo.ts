// Fork adaptation of upstream 2733b5b; current Kilo cloud schema reviewed at 87f5980.
import type { AccountingDocument, AccountingRow } from "./accounting.js";
import { accountingQuantityFromNumber } from "./accounting.js";
import { fetchWithTimeout } from "./http.js";
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
function row(
  id: string,
  name: string,
  value: AccountingRow["value"],
  resultType: AccountingRow["resultType"],
  supplementary = false,
): AccountingRow {
  return {
    id,
    name,
    resultType,
    prominence: supplementary ? "supplementary" : "primary",
    source: {
      id: "kilo",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    account: { kind: "unknown" },
    freshness: { kind: "unknown" },
    window: { kind: "unknown" },
    value,
  };
}
const amount = (n: number): AccountingRow["value"] => ({
  kind: "quantity",
  quantity: accountingQuantityFromNumber(n, { kind: "currency", code: "USD" })!,
});
export function parseKiloBalance(payload: unknown): AccountingRow {
  if (!record(payload) || !finite(payload.balance)) throw new Error("Invalid Kilo balance");
  return row("balance", "Kilo personal balance", amount(payload.balance), "balance");
}
export function parseKiloPass(payload: unknown): AccountingRow[] {
  const item = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
  if (!record(item) || !record(item.result) || !record(item.result.data))
    throw new Error("Invalid Kilo Pass response");
  const data = item.result.data;
  const root = "json" in data ? data.json : data;
  if (!record(root) || !("subscription" in root)) throw new Error("Invalid Kilo Pass state");
  if (root.subscription === null) return [];
  const sub = root.subscription;
  if (
    !record(sub) ||
    !nonnegative(sub.currentPeriodBaseCreditsUsd) ||
    !nonnegative(sub.currentPeriodUsageUsd)
  )
    throw new Error("Invalid Kilo Pass accounting");
  const rows = [
    row(
      "pass-base",
      "Kilo Pass base credits",
      amount(sub.currentPeriodBaseCreditsUsd),
      "budget",
      true,
    ),
    row("pass-spend", "Kilo Pass period spend", amount(sub.currentPeriodUsageUsd), "spend", true),
  ];
  for (const item of rows) item.window = { kind: "identified", id: "pass-period" };
  // Current-period usage already includes credit-funded hosting; do not add it twice.
  if (sub.currentPeriodHostingCostUsd !== undefined) {
    if (!nonnegative(sub.currentPeriodHostingCostUsd))
      throw new Error("Invalid Kilo hosting spend");
    rows.push(
      row(
        "pass-hosting",
        "Kilo hosting spend (included in period spend)",
        amount(sub.currentPeriodHostingCostUsd),
        "spend",
        true,
      ),
    );
  }
  const bonus = sub.currentPeriodBonus;
  if (record(bonus) && bonus.status === "issued" && nonnegative(bonus.actualAmountUsd))
    rows.push(
      row(
        "pass-bonus-issued",
        "Kilo Pass issued bonus",
        amount(bonus.actualAmountUsd),
        "budget",
        true,
      ),
    );
  else if (record(bonus) && bonus.status === "available" && nonnegative(bonus.projectedAmountUsd))
    rows.push(
      row(
        "pass-bonus-potential",
        "Kilo Pass potential bonus (not issued)",
        amount(bonus.projectedAmountUsd),
        "budget",
        true,
      ),
    );
  else
    rows.push(
      row(
        "pass-bonus-unknown",
        "Kilo Pass bonus state",
        { kind: "status", status: "unknown" },
        "status",
        true,
      ),
    );
  if (typeof sub.nextBillingAt === "string" && Number.isFinite(Date.parse(sub.nextBillingAt)))
    rows.push(
      row(
        "pass-billing",
        "Kilo next billing (not a quota reset)",
        { kind: "status", status: "available", detail: new Date(sub.nextBillingAt).toISOString() },
        "status",
        true,
      ),
    );
  return rows;
}
async function request(url: string, key: string, timeoutMs?: number): Promise<unknown> {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    },
    timeoutMs,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 65536) throw new Error("Response too large");
  return JSON.parse(text);
}
export async function queryKiloQuota(
  key: string,
  timeoutMs?: number,
): Promise<{ accounting: AccountingDocument; errors: string[] }> {
  const query = new URLSearchParams({ batch: "1", input: JSON.stringify({ "0": null }) });
  const results = await Promise.allSettled([
    request("https://api.kilo.ai/api/profile/balance", key, timeoutMs).then(parseKiloBalance),
    request(`https://app.kilo.ai/api/trpc/kiloPass.getState?${query}`, key, timeoutMs).then(
      parseKiloPass,
    ),
  ]);
  const rows: AccountingRow[] = [],
    errors: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled")
      rows.push(...(Array.isArray(result.value) ? result.value : [result.value]));
    else
      errors.push(
        index === 0
          ? "Kilo personal balance unavailable (transport, permission or invalid response)"
          : "Kilo Pass details unavailable (transport, permission or invalid response)",
      );
  });
  return { accounting: { version: 1, rows }, errors };
}
