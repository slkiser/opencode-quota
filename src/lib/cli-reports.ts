/**
 * The reports behind `opencode-quota show` and `status`. The terminal command builds them
 * in its own process (`cli-show.ts`) and prints them.
 */

import { snapshotFilePath } from "../core/persist.js";
import { loadProviderSource, type ProviderSourceHost } from "../core/provider-source.js";
import { createQuotaStore } from "../core/store.js";
import { checkProviders, quotaReportLines, statusReport } from "./quota-dialog-commands.js";
import type { QuotaExport } from "./quota-export-types.js";
import { buildQuotaExportFromSnapshot } from "./quota-export.js";

export type CliReport = { exitCode: number; stdout: string; stderr: string };

function line(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

/**
 * `show`: live quota rows as text, a line per row with its reset, then one line per provider
 * problem. Exit 1 when no provider returned a row.
 */
export async function buildCliShowText(host: ProviderSourceHost): Promise<CliReport> {
  const snapshot = await checkProviders(host);
  const { words } = host.settings().settings;
  const lines = quotaReportLines({ ...snapshot, words }, Date.now());
  if (lines.length === 0) {
    return { exitCode: 1, stdout: "", stderr: line("No provider data available.") };
  }
  const anyRow = snapshot.providers.some((provider) => provider.rows.length > 0);
  return { exitCode: anyRow ? 0 : 1, stdout: line(lines.join("\n")), stderr: "" };
}

/**
 * `show --json`: the last known quota (the snapshot file OpenCode keeps) as export JSON; no
 * provider is asked. With a threshold, exit 1 when a percentage is below it and 2 when the
 * data is incomplete or has no percentage to compare.
 */
export async function buildCliShowJson(params: {
  host: ProviderSourceHost;
  threshold?: number;
}): Promise<CliReport> {
  const { host, threshold } = params;
  const store = createQuotaStore({
    source: () => loadProviderSource(host),
    file: snapshotFilePath(),
  });
  let exportData: QuotaExport;
  try {
    exportData = buildQuotaExportFromSnapshot(await store.snapshot({ refresh: false }));
  } finally {
    await store.dispose();
  }

  const report = (exitCode: number): CliReport => ({
    exitCode,
    stdout: line(JSON.stringify(exportData, null, 2)),
    stderr: "",
  });

  if (threshold !== undefined) {
    const providerResults = Object.values(exportData.providers);
    if (providerResults.some((provider) => provider.status !== "ok")) {
      return report(2);
    }

    const okProviders = providerResults.filter(
      (p): p is Extract<typeof p, { status: "ok" }> => p.status === "ok",
    );

    if (okProviders.length === 0) {
      // No saved quota to compare against: distinct from "below threshold" (1).
      return report(2);
    }

    let hasComparablePercent = false;
    for (const provider of okProviders) {
      const percents = provider.entries
        .filter((entry) => entry.renderType === "percent")
        .map((entry) => entry.percentRemaining);
      if (percents.length === 0) continue;
      hasComparablePercent = true;
      const minPercent = Math.min(...percents);
      if (minPercent < threshold) {
        return report(1);
      }
    }

    if (!hasComparablePercent) {
      return report(2);
    }
  }

  return report(0);
}

/**
 * `status`: the Quota Status report as text, or its payload as JSON. With JSON, exit 2 when
 * no provider produced comparable data.
 */
export async function buildCliStatus(params: {
  host: ProviderSourceHost;
  providerId?: string;
  json: boolean;
}): Promise<CliReport> {
  const report = await statusReport(params.host, {
    origin: "cli",
    onlyProviderId: params.providerId,
    nowMs: Date.now(),
  });

  if (params.json) {
    return {
      exitCode: report.hasComparableProviderData ? 0 : 2,
      stdout: line(JSON.stringify(report.json, null, 2)),
      stderr: "",
    };
  }

  return { exitCode: 0, stdout: line(report.text), stderr: "" };
}
