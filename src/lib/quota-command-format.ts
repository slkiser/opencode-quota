/**
 * Verbose quota status formatter for /quota.
 *
 * This is intentionally more verbose than the toast:
 * - Always shows reset countdown when available
 * - Uses one line per limit, grouped under provider headers
 * - Includes session token summary (input/output per model)
 */

import { type AccountingRowInterpretation, interpretAccountingRow } from "./accounting-format.js";
import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import { isValueEntry } from "./entries.js";
import {
  bar,
  formatDisplayedPercentLabel,
  formatLocalCallTimestamp,
  formatResetCountdown,
  formatTokenCount,
  padLeft,
  padRight,
  resolveDisplayedPercent,
} from "./format-utils.js";
import { groupQuotaEntries } from "./grouped-entry-normalization.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { classifyQuotaWindowText, type QuotaWindowKind } from "./quota-entry-display.js";
import {
  type ReportDocument,
  type ReportSection,
  renderPlainTextReport,
} from "./report-document.js";
import { SESSION_TOKEN_SECTION_HEADING } from "./session-tokens-format.js";
import type { QuotaToastConfig } from "./types.js";

function formatResetsIn(iso?: string): string {
  if (!iso || !Number.isFinite(new Date(iso).getTime())) return "";
  return ` | resets in ${formatResetCountdown(iso)}`;
}

export const QUOTA_COMMAND_BAR_WIDTH = 10;
export const QUOTA_COMMAND_LABEL_WIDTH = 12;

function normalizeMetricText(value?: string): string {
  return value?.trim().replace(/:+$/u, "").trim() ?? "";
}

const COMMAND_WINDOW_LABELS: Readonly<Partial<Record<QuotaWindowKind, string>>> = {
  rpm: "RPM",
  five_hour: "5h",
  hour: "Hour",
  week: "Week",
  day: "Day",
  month: "Month",
  year: "Year",
};

function getCommandWindowLabel(entry: QuotaToastEntry): string | null {
  const kind = classifyQuotaWindowText(normalizeMetricText(entry.label || entry.name));
  return kind ? (COMMAND_WINDOW_LABELS[kind] ?? null) : null;
}

function getCommandMetricLabel(entry: QuotaToastEntry, semanticLabel: string): string {
  if (entry.semantic) return semanticLabel;

  const window = getCommandWindowLabel(entry);
  const resultType = entry.accounting?.resultType;

  if (resultType === "balance") return "Balance";
  if (resultType === "status") return "Status";

  const explicit = normalizeMetricText(entry.label);
  const metricLabel = normalizeMetricText(entry.metricLabel);
  const noun =
    resultType === "budget"
      ? "budget"
      : resultType === "usage"
        ? "usage"
        : resultType === "spend"
          ? "spend"
          : resultType === "quota" || resultType === "rate_limit"
            ? "quota"
            : "";

  if (noun) {
    return window ? `${window} ${noun}` : metricLabel || noun[0]!.toUpperCase() + noun.slice(1);
  }
  if (window) return `${window} quota`;

  return explicit || (isValueEntry(entry) ? "Value" : "Quota");
}

function formatCommandDetails(entry: QuotaToastEntry, rightWidth: number): string {
  const right = entry.right?.trim();
  const reset = formatResetsIn(entry.resetTimeIso).replace(/^ \| resets in /u, "reset ");
  if (right && reset) return ` | ${padRight(right, rightWidth)} | ${reset}`;
  if (right) return ` | ${right}`;
  if (reset) return ` | ${reset}`;
  return "";
}

function getCommandBasisLines(basis: AccountingRowInterpretation["basis"]): string[] {
  if (!basis) return [];
  const details =
    basis.kind === "detailed"
      ? basis.facts.map((fact) => fact.text)
      : basis.text
        ? [basis.text]
        : [];
  return details.map((detail) => `    ${detail}`);
}

function buildQuotaCommandDocument(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  generatedAtMs?: number;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  accountingDetail?: QuotaToastConfig["accountingDetail"];
}): ReportDocument {
  const groups = groupQuotaEntries(params.entries, "quota");

  const sections: ReportSection[] = groups.map((group, index) => {
    const lines: string[] = [];
    const interpretedRows = group.entries.map((entry) => ({
      entry,
      interpretation: interpretAccountingRow(entry, {
        booleanWording: "semantic",
        basis:
          (params.accountingDetail ?? "summary") === "detailed"
            ? { kind: "detailed" }
            : { kind: "summary", mode: params.percentDisplayMode ?? "remaining" },
      }),
    }));
    const rightWidth = Math.max(
      0,
      ...interpretedRows.map(({ entry }) => entry.right?.trim().length ?? 0),
    );
    const labelWidth = Math.max(
      QUOTA_COMMAND_LABEL_WIDTH,
      ...interpretedRows
        .filter(({ entry }) => Boolean(entry.semantic))
        .map(
          ({ entry, interpretation }) => getCommandMetricLabel(entry, interpretation.label).length,
        ),
    );
    for (const { entry: row, interpretation } of interpretedRows) {
      const label = padRight(getCommandMetricLabel(row, interpretation.label), labelWidth);
      const details = formatCommandDetails(row, rightWidth);

      if (interpretation.display.kind === "value") {
        lines.push(`  ${label}  ${interpretation.display.text}${details}`);
        continue;
      }

      const pctLabel = formatDisplayedPercentLabel(
        interpretation.display.percentRemaining,
        params.percentDisplayMode,
      );
      const displayedPercent = resolveDisplayedPercent(
        interpretation.display.percentRemaining,
        params.percentDisplayMode,
      );
      lines.push(
        `  ${label}  ${bar(displayedPercent, QUOTA_COMMAND_BAR_WIDTH)}  ${padLeft(pctLabel, Math.max(9, pctLabel.length))}${details}`,
      );
      lines.push(...getCommandBasisLines(interpretation.basis));
    }
    return {
      id: `group-${index}`,
      title: `→ ${formatGroupedHeader(group.group)}`,
      blocks: [{ kind: "lines", lines }],
    };
  });

  if (params.sessionTokens && params.sessionTokens.models.length > 0) {
    sections.push({
      id: "session-tokens",
      title: SESSION_TOKEN_SECTION_HEADING,
      blocks: [
        {
          kind: "lines",
          lines: params.sessionTokens.models.map((model) => {
            const metrics = [`${formatTokenCount(model.input)} in`];
            if ((model.cachedInput ?? 0) > 0) {
              metrics.push(`${formatTokenCount(model.cachedInput ?? 0)} cached`);
            }
            metrics.push(`${formatTokenCount(model.output)} out`);
            return `  ${model.modelID}: ${metrics.join(" | ")}`;
          }),
        },
      ],
    });
  }

  if (params.errors.length > 0) {
    sections.push({
      id: "errors",
      title: "Partial failures",
      blocks: [
        {
          kind: "lines",
          lines: params.errors.map((err) => `  ${err.label}: ${err.message}`),
        },
      ],
    });
  }

  return {
    sections: [
      {
        id: "heading",
        blocks: [
          {
            kind: "lines",
            lines: [`Quota (/quota) ${formatLocalCallTimestamp(params.generatedAtMs)}`],
          },
        ],
      },
      ...sections,
    ],
  };
}

export function formatQuotaCommand(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  generatedAtMs?: number;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  accountingDetail?: QuotaToastConfig["accountingDetail"];
}): string {
  return renderPlainTextReport(buildQuotaCommandDocument(params));
}
