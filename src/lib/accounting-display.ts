import { projectQuotaRunway, formatQuotaRunway } from "./quota-runway.js";
import {
  isAccountingDocument,
  formatAccountingQuantity,
  projectAccountingToLegacy,
} from "./accounting.js";
import type { AccountingRow } from "./accounting.js";
import type { QuotaProviderResult, QuotaToastEntry } from "./entries.js";
import { sanitizeSingleLineDisplaySnippet as clean } from "./display-sanitize.js";

export interface AccountingDisplayRow {
  key: string;
  providerId: string;
  name: string;
  value: string;
  prominence: "primary" | "supplementary";
  valueKind: AccountingRow["value"]["kind"];
  accountIdentity: string;
  windowId?: string;
  runway?: string;
  facts: Array<{ label: string; value: string }>;
}
const authority = (value: string) =>
  value === "provider_reported"
    ? "Provider reported"
    : value === "locally_derived"
      ? "Locally derived"
      : value === "user_configured"
        ? "User configured"
        : "Authority unknown";
export function displayQuotaEntries(result: QuotaProviderResult): QuotaToastEntry[] {
  return result.entries.length || !isAccountingDocument(result.accounting)
    ? result.entries
    : projectAccountingToLegacy(result.accounting);
}
function valueText(row: AccountingRow): string {
  const value = row.value;
  if (value.kind === "quantity")
    return value.quantity ? formatAccountingQuantity(value.quantity) : "Unknown";
  if (value.kind === "percent")
    return value.remaining === null ? "Unknown" : `${value.remaining}% remaining`;
  if (value.kind === "boolean")
    return value.value === null ? "Unknown" : value.value ? "Yes" : "No";
  const status = {
    unknown: "Unknown",
    unlimited: "Unlimited",
    available: "Available",
    unavailable: "Unavailable",
  }[value.status];
  return value.detail ? `${status}: ${clean(value.detail, 500)}` : status;
}
export function projectAccountingDetails(
  providerId: string,
  result: QuotaProviderResult,
  options: { quotaProjection?: "none" | "runway"; now?: number } = {},
): AccountingDisplayRow[] {
  if (!isAccountingDocument(result.accounting)) return [];
  return result.accounting.rows.map((row) => {
    const identity = row.account.kind === "opaque" ? row.account.digest : "unknown";
    const facts: AccountingDisplayRow["facts"] = [
      { label: "Source", value: authority(row.source.authority) },
      {
        label: "Account",
        value: identity === "unknown" ? "Unknown" : `Account ${identity.slice(0, 8)}`,
      },
      {
        label: "Source observation",
        value: row.freshness.kind === "observed" ? row.freshness.observedAtIso : "Unknown",
      },
    ];
    const projection =
      options.quotaProjection === "runway" ? projectQuotaRunway(row, options.now) : null;
    const runway = projection ? formatQuotaRunway(projection, options.now) : undefined;
    if (runway) {
      facts.push({ label: "Runway", value: runway });
      facts.push({
        label: "Estimate basis",
        value: "Linear average since fixed-window start; not a recent-rate prediction",
      });
      facts.push({ label: "Reset", value: new Date(projection!.resetAt).toISOString() });
    }
    const fetched = result.observation ? new Date(result.observation.observedAt) : null;
    if (fetched && Number.isFinite(fetched.getTime()))
      facts.push({ label: "Fetched", value: fetched.toISOString() });
    if (row.window.kind !== "unknown") {
      const windowName =
        providerId === "openai" && row.window.id === "hourly"
          ? "Five-hour"
          : ((
              {
                weekly: "Weekly",
                monthly: "Monthly",
                codeReview: "Code review",
                "billing-period": "Billing period",
              } as Record<string, string>
            )[row.window.id] ?? row.window.id);
      facts.push({ label: "Window", value: clean(windowName, 200) });
      if (row.window.kind === "fixed")
        facts.push({
          label: "Period",
          value: `${row.window.startedAtIso} → ${row.window.endsAtIso}`,
        });
      else if (row.window.resetTimeIso)
        facts.push({ label: "Reset", value: row.window.resetTimeIso });
    }
    if (row.value.kind === "percent" && row.value.basis)
      for (const key of ["used", "limit", "remaining"] as const) {
        const fact = row.value.basis[key];
        if (fact)
          facts.push({
            label: key[0].toUpperCase() + key.slice(1),
            value: `${formatAccountingQuantity(fact.quantity)} (${authority(fact.authority)})`,
          });
      }
    return {
      key: `${providerId}:${identity}:${row.id}`,
      providerId: clean(providerId, 200),
      name: clean(row.name, 500),
      value: clean(valueText(row), 1000),
      valueKind: row.value.kind,
      prominence: row.prominence,
      accountIdentity: identity,
      ...(runway ? { runway } : {}),
      ...(row.window.kind !== "unknown" ? { windowId: row.window.id } : {}),
      facts: facts.map((fact) => ({
        label: clean(fact.label, 200),
        value: clean(fact.value, 1000),
      })),
    };
  });
}

export function formatCompactAccountingDetails(rows: AccountingDisplayRow[], width = 50): string {
  const estimates = rows
    .filter((row) => row.runway)
    .map((row) => `${row.name}: ${row.runway} (average since start)`);
  const extras = rows.filter(
    (row) =>
      row.prominence === "supplementary" &&
      (row.valueKind === "quantity" || row.value === "Unlimited"),
  );
  const bound = Math.max(16, Math.floor(width));
  const lines: string[] = [];
  for (const text of [
    ...estimates.slice(0, 4),
    ...extras.slice(0, 2).map((row) => `${row.name}: ${row.value}`),
  ]) {
    const chars = Array.from(clean(text, 1500));
    while (chars.length) lines.push(chars.splice(0, bound).join(""));
  }
  if (extras.length > 2) lines.push("More details: /quota".slice(0, bound));
  return lines.join("\n");
}

/** Bound verbose lines without truncating decimal facts or injecting controls. */
export function formatAccountingDetails(rows: AccountingDisplayRow[], width = 80): string {
  if (!rows.length) return "";
  const lines = ["Accounting details"];
  for (const row of rows) {
    lines.push(
      `${row.providerId} / ${row.name}: ${row.value}${row.prominence === "supplementary" ? " (supplementary)" : ""}`,
    );
    for (const fact of row.facts) lines.push(`  ${fact.label}: ${fact.value}`);
  }
  const bound = Math.max(16, Math.floor(width));
  return lines
    .flatMap((line) => {
      const chars = Array.from(clean(line, 4000));
      const chunks: string[] = [];
      while (chars.length) chunks.push(chars.splice(0, bound).join(""));
      return chunks.length ? chunks : [""];
    })
    .join("\n");
}
