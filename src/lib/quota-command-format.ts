/**
 * Verbose quota status formatter for /quota.
 *
 * This is intentionally more verbose than the toast:
 * - Always shows reset countdown when available
 * - Uses one line per limit, grouped under provider headers
 * - Includes session token summary (input/output per model)
 */

import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import type { PercentDisplayMode } from "./types.js";
import { isValueEntry } from "./entries.js";
import {
  bar,
  formatDisplayedPercentLabel,
  formatTokenCount,
  padLeft,
  padRight,
  resolveDisplayedPercent,
} from "./format-utils.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { groupQuotaEntries } from "./grouped-entry-normalization.js";
import {
  renderPlainTextReport,
  type ReportDocument,
  type ReportSection,
} from "./report-document.js";
import { SESSION_TOKEN_SECTION_HEADING } from "./session-tokens-format.js";

/**
 * Format reset time in compact form (different from toast countdown).
 * Uses seconds/minutes/hours/days format for /quota command.
 */
function formatResetTimeSeconds(diffSeconds: number): string {
  if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) return "now";
  if (diffSeconds < 60) return `${Math.ceil(diffSeconds)}s`;
  if (diffSeconds < 3600) return `${Math.ceil(diffSeconds / 60)}m`;
  if (diffSeconds < 86400) return `${Math.round(diffSeconds / 3600)}h`;
  return `${Math.round(diffSeconds / 86400)}d`;
}

function formatResetsIn(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffSeconds = (t - Date.now()) / 1000;
  return ` · resets in ${formatResetTimeSeconds(diffSeconds)}`;
}

export const QUOTA_COMMAND_BAR_WIDTH = 10;
export const QUOTA_COMMAND_LABEL_WIDTH = 12;

function normalizeMetricText(value?: string): string {
  return value?.trim().replace(/:+$/u, "").trim() ?? "";
}

function getCommandWindowLabel(entry: QuotaToastEntry): string | null {
  const text = normalizeMetricText(entry.label || entry.name).toLowerCase();
  if (/\b(?:rpm|per minute|minute|minutes)\b/u.test(text)) return "RPM";
  if (/\b(?:rolling|5h|5 h|5-hour|5 hour|five-hour|five hour)\b/u.test(text)) return "5h";
  if (/\b(?:hourly|1h|1 h|1-hour|1 hour|hour)\b/u.test(text)) return "Hour";
  if (/\b(?:7d|7 d|7-day|7 day|weekly|week)\b/u.test(text)) return "Week";
  if (/\b(?:daily|1d|1 d|1-day|1 day|day)\b/u.test(text)) return "Day";
  if (/\b(?:monthly|month)\b/u.test(text)) return "Month";
  if (/\b(?:yearly|annual|annually|year)\b/u.test(text)) return "Year";
  return null;
}

function getCommandMetricLabel(entry: QuotaToastEntry): string {
  const window = getCommandWindowLabel(entry);
  const resultType = entry.accounting?.resultType;

  if (resultType === "balance") return "Balance";
  if (resultType === "status") return "Status";

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

  if (noun) return window ? `${window} ${noun}` : noun[0]!.toUpperCase() + noun.slice(1);
  if (window) return `${window} quota`;

  const explicit = normalizeMetricText(entry.label);
  return explicit || (isValueEntry(entry) ? "Value" : "Quota");
}

function formatCommandDetails(entry: QuotaToastEntry, rightWidth: number): string {
  const right = entry.right?.trim();
  const reset = formatResetsIn(entry.resetTimeIso).replace(/^ · resets in /u, "reset ");
  if (right && reset) return ` · ${padRight(right, rightWidth)} · ${reset}`;
  if (right) return ` · ${right}`;
  if (reset) return ` · ${reset}`;
  return "";
}

function buildQuotaCommandDocument(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  generatedAtMs?: number;
  percentDisplayMode?: PercentDisplayMode;
}): ReportDocument {
  const groups = groupQuotaEntries(params.entries, "quota");

  const sections: ReportSection[] = groups.map((group, index) => {
    const lines: string[] = [];
    const rightWidth = Math.max(0, ...group.entries.map((row) => row.right?.trim().length ?? 0));
    for (const row of group.entries) {
      const label = padRight(getCommandMetricLabel(row), QUOTA_COMMAND_LABEL_WIDTH);
      const details = formatCommandDetails(row, rightWidth);

      if (isValueEntry(row)) {
        lines.push(`  ${label}  ${row.value}${details}`);
        continue;
      }

      const pctLabel = formatDisplayedPercentLabel(row.percentRemaining, params.percentDisplayMode);
      const displayedPercent = resolveDisplayedPercent(
        row.percentRemaining,
        params.percentDisplayMode,
      );
      lines.push(
        `  ${label}  ${bar(displayedPercent, QUOTA_COMMAND_BAR_WIDTH)}  ${padLeft(pctLabel, 9)}${details}`,
      );
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
            return `  ${model.modelID}: ${metrics.join(" · ")}`;
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
    heading: {
      title: "Quota (/quota)",
      generatedAtMs: params.generatedAtMs,
    },
    sections,
  };
}

export function formatQuotaCommand(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  generatedAtMs?: number;
  percentDisplayMode?: PercentDisplayMode;
}): string {
  return renderPlainTextReport(buildQuotaCommandDocument(params));
}
