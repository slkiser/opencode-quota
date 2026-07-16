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
import { formatDisplayedPercentLabel, formatTokenCount } from "./format-utils.js";
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

function getGroupedLeftText(entry: QuotaToastEntry): string {
  const label = (entry.label ?? entry.name).trim();
  const right = entry.right?.trim();
  return right ? `${label} ${right}` : label;
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
    for (const row of group.entries) {
      const leftText = getGroupedLeftText(row);
      const suffix = formatResetsIn(row.resetTimeIso);

      if (isValueEntry(row)) {
        lines.push(`  ${leftText} ${row.value}${suffix}`);
        continue;
      }

      const pctLabel = formatDisplayedPercentLabel(row.percentRemaining, params.percentDisplayMode);
      const metricSeparator = row.right?.trim() ? " · " : " ";
      lines.push(`  ${leftText}${metricSeparator}${pctLabel}${suffix}`);
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
