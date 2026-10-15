import type {
  AccountingDocument,
  AccountingRow,
  AccountingUnit,
  AccountingAuthority,
} from "../lib/accounting.js";
import { accountingQuantityFromNumber } from "../lib/accounting.js";
import type { OpenAIResult } from "../lib/openai.js";
import type { CopilotResult } from "../lib/types.js";

function row(
  provider: string,
  id: string,
  name: string,
  resultType: AccountingRow["resultType"],
  authority: AccountingAuthority,
): AccountingRow {
  return {
    id,
    name,
    resultType,
    prominence: "primary",
    source: { id: provider, acquisitionMethod: "remote_api", ownership: "maintained", authority },
    account: { kind: "unknown" },
    freshness: { kind: "unknown" },
    window: { kind: "unknown" },
    value: { kind: "status", status: "unknown" },
  };
}

export function openAIAccounting(
  result: Extract<OpenAIResult, { success: true }>,
): AccountingDocument {
  const rows: AccountingRow[] = [];
  for (const [key, label] of [
    ["hourly", "5h"],
    ["weekly", "Weekly"],
    ["monthly", "Monthly"],
    ["codeReview", "Code Review"],
  ] as const) {
    const window = result.windows[key];
    if (!window) continue;
    rows.push({
      ...row("openai", key, `${result.label} ${label}`, "quota", "provider_reported"),
      group: result.label,
      label: `${label}:`,
      window: {
        kind: "identified",
        id: key,
        ...(window.resetTimeIso ? { resetTimeIso: window.resetTimeIso } : {}),
      },
      value: {
        kind: "percent",
        remaining: Number.isFinite(window.percentRemaining) ? window.percentRemaining : null,
      },
    });
  }
  // A credit balance string has no declared unit/currency; preserve unknown rather
  // than pretending it is USD. Eligibility flags remain typed supplementary facts.
  if (result.credits) {
    rows.push({
      ...row("openai", "credits-available", "Credits available", "status", "provider_reported"),
      prominence: "supplementary",
      value: { kind: "boolean", value: result.credits.hasCredits },
    });
    if (result.credits.balance !== null)
      rows.push({
        ...row(
          "openai",
          "credits-balance",
          "Credit balance (unit unknown)",
          "balance",
          "provider_reported",
        ),
        prominence: "supplementary",
        value: { kind: "status", status: "unknown", detail: result.credits.balance },
      });
    if (result.credits.unlimited)
      rows.push({
        ...row("openai", "credits-unlimited", "Credits", "balance", "provider_reported"),
        prominence: "supplementary",
        value: { kind: "status", status: "unlimited" },
      });
  }
  return { version: 1, rows };
}

export function copilotAccounting(
  result: Extract<CopilotResult, { success: true }>,
): AccountingDocument {
  const knownAuthority = (value: unknown): AccountingAuthority =>
    value === "provider_reported" || value === "locally_derived" ? value : "unknown";
  const authority = knownAuthority(result.authority);
  const rows: AccountingRow[] = [];
  const window: AccountingRow["window"] = {
    kind: "identified",
    id: "billing-period",
    ...(result.resetTimeIso ? { resetTimeIso: result.resetTimeIso } : {}),
  };
  if (result.mode === "user_plan")
    return {
      version: 1,
      rows: [
        {
          ...row("copilot", "plan", "Copilot plan", "status", authority),
          window,
          value: {
            kind: "status",
            status: "unknown",
            ...(result.plan ? { detail: result.plan } : {}),
          },
        },
      ],
    };
  const unit: AccountingUnit = {
    kind: "count",
    unit:
      result.unit === "ai_credits"
        ? "credit"
        : result.unit === "premium_interactions"
          ? "interaction"
          : "request",
  };
  const used = accountingQuantityFromNumber(result.used, unit);
  const quota = row(
    "copilot",
    "usage",
    "Copilot usage",
    result.mode === "user_quota" ? "quota" : "usage",
    authority,
  );
  quota.window = window;
  if (result.mode === "user_quota" && result.unlimited)
    quota.value = { kind: "status", status: "unlimited" };
  else if (
    result.mode === "user_quota" &&
    result.percentRemaining !== undefined &&
    Number.isFinite(result.percentRemaining)
  ) {
    const limit =
      result.total === undefined ? null : accountingQuantityFromNumber(result.total, unit);
    quota.value = {
      kind: "percent",
      remaining: result.percentRemaining,
      basis: {
        ...(used ? { used: { quantity: used, authority } } : {}),
        ...(limit ? { limit: { quantity: limit, authority } } : {}),
      },
    };
  } else quota.value = { kind: "quantity", quantity: used };
  rows.push(quota);
  for (const [id, name, value, fieldUnit, resultType] of [
    ["included", "Included usage", result.includedUsed, unit, "usage"],
    ["billed", "Billed usage", result.billedUsed, unit, "usage"],
    [
      "billed-usd",
      "Billed spend",
      result.billedAmountUsd,
      { kind: "currency", code: "USD" },
      "spend",
    ],
  ] as const) {
    if (value !== undefined)
      rows.push({
        ...row("copilot", id, name, resultType, authority),
        window: { ...window },
        prominence: "supplementary",
        value: { kind: "quantity", quantity: accountingQuantityFromNumber(value, fieldUnit) },
      });
  }
  if (result.budget) {
    const budget = result.budget;
    const budgetAuthority = knownAuthority(budget.authority);
    const usd: AccountingUnit = { kind: "currency", code: "USD" };
    const limit = accountingQuantityFromNumber(budget.amountUsd, usd);
    const spent =
      budget.spentUsd === undefined ? null : accountingQuantityFromNumber(budget.spentUsd, usd);
    const base = {
      ...row("copilot", "budget", "Copilot additional usage budget", "budget", budgetAuthority),
      window: { ...window },
    };
    rows.push({
      ...base,
      value:
        budget.percentRemaining !== undefined && Number.isFinite(budget.percentRemaining)
          ? {
              kind: "percent",
              remaining: budget.percentRemaining,
              basis: {
                ...(limit ? { limit: { quantity: limit, authority: budgetAuthority } } : {}),
                ...(spent ? { used: { quantity: spent, authority: budgetAuthority } } : {}),
              },
            }
          : { kind: "quantity", quantity: limit },
    });
    if (budget.spentUsd !== undefined && budget.percentRemaining === undefined)
      rows.push({
        ...row("copilot", "budget-spend", "Additional usage spend", "spend", budgetAuthority),
        window: { ...window },
        prominence: "supplementary",
        value: { kind: "quantity", quantity: spent },
      });
  }
  return { version: 1, rows };
}
