import type {
  AccountingComponent,
  AccountingCountUnit,
  AccountingPercentageBasis,
  AccountingQuantity,
  AccountingResultType,
  AccountingSemantic,
  AccountingUnit,
  AccountingWindow,
  QuotaToastEntry,
} from "./entries.js";
import { isBooleanEntry, isPercentEntry, isQuantityEntry, isValueEntry } from "./entries.js";

const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

const RESULT_TYPE_LABELS: Readonly<Record<AccountingResultType, string>> = {
  quota: "Quota",
  rate_limit: "Rate limit",
  usage: "Usage",
  spend: "Spend",
  budget: "Budget",
  balance: "Balance",
  status: "Status",
};

const RESULT_TYPE_ORDER: Readonly<Record<AccountingResultType, number>> = {
  quota: 0,
  rate_limit: 1,
  budget: 2,
  usage: 3,
  spend: 4,
  balance: 5,
  status: 6,
};

const WINDOW_LABELS: Readonly<Record<AccountingWindow, string>> = {
  rpm: "RPM",
  hour: "Hourly",
  five_hour: "5h",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
  mcp: "MCP",
  code_review: "Code Review",
};

const WINDOW_ORDER: Readonly<Record<AccountingWindow, number>> = {
  rpm: 0,
  hour: 1,
  five_hour: 2,
  day: 3,
  week: 4,
  month: 5,
  year: 6,
  mcp: 7,
  code_review: 8,
};

const COMPONENT_LABELS: Readonly<Record<AccountingComponent, string>> = {
  current_balance: "Current balance",
  total_balance: "Total balance",
  cash_balance: "Cash balance",
  gift_balance: "Gift balance",
  granted_balance: "Granted balance",
  topped_up_balance: "Topped-up balance",
  remaining_credits: "Remaining credits",
  auto_reload: "Auto-reload",
  auto_reload_amount: "Auto-reload amount",
  auto_reload_trigger: "Auto-reload trigger",
};

const COMPONENT_ORDER: Readonly<Record<AccountingComponent, number>> = {
  current_balance: 0,
  remaining_credits: 0,
  total_balance: 1,
  cash_balance: 2,
  gift_balance: 3,
  granted_balance: 4,
  topped_up_balance: 5,
  auto_reload: 6,
  auto_reload_amount: 7,
  auto_reload_trigger: 8,
};

const COUNT_LABELS: Readonly<Record<AccountingCountUnit, [singular: string, plural: string]>> = {
  request: ["request", "requests"],
  token: ["token", "tokens"],
  credit: ["credit", "credits"],
  message: ["message", "messages"],
  interaction: ["interaction", "interactions"],
  unit: ["unit", "units"],
};

export function isCanonicalAccountingDecimal(value: string): boolean {
  if (!CANONICAL_DECIMAL_RE.test(value)) return false;
  if (!value.startsWith("-")) return true;
  return !/^0(?:\.0+)?$/u.test(value.slice(1));
}

function splitDecimal(decimal: string): {
  negative: boolean;
  integer: string;
  fraction: string;
} {
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [integer = "0", fraction = ""] = unsigned.split(".", 2);
  return { negative, integer, fraction };
}

function groupInteger(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function isBelowOneCent(integer: string, fraction: string): boolean {
  return (
    integer === "0" &&
    fraction.length > 0 &&
    !/^0+$/u.test(fraction) &&
    fraction.padEnd(2, "0").slice(0, 2) === "00"
  );
}

function incrementIntegerString(integer: string): string {
  return (BigInt(integer) + 1n).toString();
}

function formatCurrencyAmount(decimal: string): string {
  const { negative, integer, fraction } = splitDecimal(decimal);
  if (isBelowOneCent(integer, fraction)) {
    if (!negative) return "<0.01";
    return `-${integer}.${fraction}`;
  }

  const padded = `${fraction}000`;
  let cents = Number(padded.slice(0, 2));
  let roundedInteger = integer;
  if (Number(padded[2]) >= 5) cents += 1;
  if (cents === 100) {
    roundedInteger = incrementIntegerString(integer);
    cents = 0;
  }
  return `${negative ? "-" : ""}${groupInteger(roundedInteger)}.${String(cents).padStart(2, "0")}`;
}

function formatExactAmount(decimal: string): string {
  const { negative, integer, fraction } = splitDecimal(decimal);
  return `${negative ? "-" : ""}${groupInteger(integer)}${fraction ? `.${fraction}` : ""}`;
}

export function accountingUnitsEqual(left: AccountingUnit, right: AccountingUnit): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "currency" && right.kind === "currency") return left.code === right.code;
  if (left.kind === "count" && right.kind === "count") return left.unit === right.unit;
  if (left.kind === "custom" && right.kind === "custom") return left.symbol === right.symbol;
  return false;
}

export function formatAccountingQuantity(quantity: AccountingQuantity): string {
  if (!isCanonicalAccountingDecimal(quantity.decimal)) {
    throw new TypeError("Accounting quantity decimal must be canonical");
  }

  if (quantity.unit.kind === "currency") {
    return `${quantity.unit.code} ${formatCurrencyAmount(quantity.decimal)}`;
  }

  const amount = formatExactAmount(quantity.decimal);
  if (quantity.unit.kind === "custom") return `${amount} ${quantity.unit.symbol}`;

  const labels = COUNT_LABELS[quantity.unit.unit];
  const singular = /^1(?:\.0+)?$/u.test(quantity.decimal);
  return `${amount} ${singular ? labels[0] : labels[1]}`;
}

export function formatAccountingBoolean(value: boolean, semantic?: AccountingSemantic): string {
  if (semantic?.metric.kind === "named" && semantic.metric.name === "Availability") {
    return value ? "Available" : "Low balance";
  }
  return value ? "Enabled" : "Disabled";
}

export type AccountingBasisDisplayMode = "remaining" | "used";

export function formatAccountingBasisSummary(
  basis: AccountingPercentageBasis,
  mode: AccountingBasisDisplayMode,
): string | null {
  if (mode === "remaining" && basis.remaining) {
    return `Remaining: ${formatAccountingQuantity(basis.remaining.quantity)}`;
  }
  if (mode === "used" && basis.used) {
    return `Used: ${formatAccountingQuantity(basis.used.quantity)}`;
  }
  if (basis.used && basis.limit) {
    return `Used: ${formatAccountingQuantity(basis.used.quantity)} / Limit: ${formatAccountingQuantity(
      basis.limit.quantity,
    )}`;
  }
  return null;
}

export type AccountingBasisFact = {
  role: "used" | "limit" | "remaining";
  text: string;
};

function buildAccountingBasisFacts(basis: AccountingPercentageBasis): AccountingBasisFact[] {
  const facts: AccountingBasisFact[] = [];
  if (basis.used) {
    facts.push({ role: "used", text: `Used: ${formatAccountingQuantity(basis.used.quantity)}` });
  }
  if (basis.limit) {
    facts.push({ role: "limit", text: `Limit: ${formatAccountingQuantity(basis.limit.quantity)}` });
  }
  if (basis.remaining) {
    facts.push({
      role: "remaining",
      text: `Remaining: ${formatAccountingQuantity(basis.remaining.quantity)}`,
    });
  }
  return facts;
}

export function formatAccountingBasisDetails(basis: AccountingPercentageBasis): string[] {
  return buildAccountingBasisFacts(basis).map((fact) => fact.text);
}

export function formatAccountingResultTypeLabel(resultType: AccountingResultType): string {
  return RESULT_TYPE_LABELS[resultType];
}

export function formatAccountingWindowLabel(window: AccountingWindow): string {
  return WINDOW_LABELS[window];
}

export function formatAccountingComponentLabel(component: AccountingComponent): string {
  return COMPONENT_LABELS[component];
}

export function formatAccountingSemanticLabel(
  resultType: AccountingResultType,
  semantic: AccountingSemantic,
  entryKind: QuotaToastEntry["kind"],
): string {
  const resultLabel = RESULT_TYPE_LABELS[resultType];
  const metric = semantic.metric;
  if (metric.kind === "aggregate") return resultLabel;
  if (metric.kind === "window") {
    return `${WINDOW_LABELS[metric.window]} ${resultLabel.toLowerCase()}`;
  }
  if (metric.kind === "component") {
    if (metric.component === "remaining_credits" && entryKind === "percent") return "Credits";
    return COMPONENT_LABELS[metric.component];
  }
  if (resultType === "status") return metric.name;
  return `${metric.name} ${resultLabel.toLowerCase()}`;
}

export type AccountingSemanticSortKey = readonly [
  resultType: number,
  metricKind: number,
  metric: number,
];

export function getAccountingSemanticSortKey(entry: QuotaToastEntry): AccountingSemanticSortKey {
  const semantic = entry.semantic;
  if (!semantic) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0];

  const resultRank = RESULT_TYPE_ORDER[entry.accounting.resultType];
  const metric = semantic.metric;
  if (metric.kind === "aggregate") return [resultRank, 0, 0];
  if (metric.kind === "window") return [resultRank, 1, WINDOW_ORDER[metric.window]];
  if (metric.kind === "component") return [resultRank, 2, COMPONENT_ORDER[metric.component]];
  return [resultRank, 3, 0];
}

export function compareAccountingSemanticEntries(
  left: QuotaToastEntry,
  right: QuotaToastEntry,
): number {
  const leftKey = getAccountingSemanticSortKey(left);
  const rightKey = getAccountingSemanticSortKey(right);
  return leftKey[0] - rightKey[0] || leftKey[1] - rightKey[1] || leftKey[2] - rightKey[2];
}

export function getAccountingEntryLabel(entry: QuotaToastEntry): string {
  if (!entry.semantic) return entry.metricLabel?.trim() || entry.label?.trim() || entry.name;
  return formatAccountingSemanticLabel(
    entry.accounting.resultType,
    entry.semantic,
    isPercentEntry(entry) ? "percent" : entry.kind,
  );
}

export type AccountingBooleanWording = "semantic" | "generic";

export type AccountingBasisRequest =
  | { kind: "summary"; mode: AccountingBasisDisplayMode }
  | { kind: "detailed" };

export type AccountingRowInterpretation = {
  label: string;
  display:
    | { kind: "percent"; percentRemaining: number }
    | {
        kind: "value";
        entryKind: "value" | "quantity" | "boolean";
        text: string;
      };
  basis?:
    | { kind: "summary"; text: string | null }
    | { kind: "detailed"; facts: readonly AccountingBasisFact[] };
};

export function interpretAccountingRow(
  entry: QuotaToastEntry,
  options: {
    booleanWording: AccountingBooleanWording;
    basis?: AccountingBasisRequest;
  },
): AccountingRowInterpretation {
  const label = getAccountingEntryLabel(entry);
  let display: AccountingRowInterpretation["display"];

  if (isPercentEntry(entry)) {
    display = { kind: "percent", percentRemaining: entry.percentRemaining };
  } else if (isValueEntry(entry)) {
    display = { kind: "value", entryKind: "value", text: entry.value };
  } else if (isQuantityEntry(entry)) {
    display = {
      kind: "value",
      entryKind: "quantity",
      text: formatAccountingQuantity(entry.quantity),
    };
  } else if (isBooleanEntry(entry)) {
    display = {
      kind: "value",
      entryKind: "boolean",
      text: formatAccountingBoolean(
        entry.value,
        options.booleanWording === "semantic" ? entry.semantic : undefined,
      ),
    };
  } else {
    return entry satisfies never;
  }

  if (!isPercentEntry(entry) || !entry.basis || !options.basis) {
    return { label, display };
  }

  const basis =
    options.basis.kind === "summary"
      ? {
          kind: "summary" as const,
          text: formatAccountingBasisSummary(entry.basis, options.basis.mode),
        }
      : { kind: "detailed" as const, facts: buildAccountingBasisFacts(entry.basis) };
  return { label, display, basis };
}
