import { describe, expect, it } from "vite-plus/test";

import type { QuotaToastEntry } from "../src/lib/entries.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
import type { PercentDisplayMode } from "../src/lib/types.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";

const accounting = {
  resultType: "quota" as const,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "provider_reported" as const,
};

function goWindow(
  name: string,
  label: string,
  percentRemaining: number,
  resetTimeIso: string,
): QuotaToastEntry {
  return {
    accounting,
    name,
    group: "OpenCode Go",
    label,
    percentRemaining,
    resetTimeIso,
  };
}

const exhaustedWeeklyEntries: QuotaToastEntry[] = [
  goWindow("OpenCode Go 5h", "5h:", 83, "2026-08-12T12:30:00.000Z"),
  goWindow("OpenCode Go Weekly", "Weekly:", 0, "2026-08-16T16:00:00.000Z"),
  goWindow("OpenCode Go Monthly", "Monthly:", 9, "2026-09-01T04:00:00.000Z"),
];

function renderSurfaces(params: {
  entries: QuotaToastEntry[];
  percentDisplayMode: PercentDisplayMode;
}): {
  command: string;
  toast: string;
  sidebar: string;
  compact: string;
} {
  const data: QuotaRenderData = { entries: params.entries, errors: [] };
  const { percentDisplayMode } = params;

  return {
    command: formatQuotaCommand({
      ...data,
      generatedAtMs: 0,
      accountingDetail: "summary",
      percentDisplayMode,
    }),
    toast: formatQuotaRows({
      version: "test",
      style: "allWindows",
      layout: { maxWidth: 64, narrowAt: 44, tinyAt: 32 },
      entries: data.entries,
      errors: data.errors,
      accountingDetail: "summary",
      percentDisplayMode,
    }),
    sidebar: buildSidebarQuotaPanelLines({
      data,
      config: {
        formatStyle: "allWindows",
        percentDisplayMode,
        accountingDetail: "summary",
      },
    }).join("\n"),
    compact: buildCompactQuotaStatusLine({
      data,
      accountingDetail: "summary",
      percentDisplayMode,
      maxWidth: 160,
    }),
  };
}

describe("OpenCode Go exhausted-window surfaces", () => {
  it("shows remaining 0% for a rate-limited window without hiding healthy siblings", () => {
    const outputs = renderAccountingFourSurfaces({
      data: { entries: exhaustedWeeklyEntries, errors: [] },
      accountingDetail: "summary",
      toastMaxWidth: 64,
      toastNarrowAt: 44,
      compactMaxWidth: 160,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("OpenCode Go");
      expect(output).toContain("0%");
      expect(output).toContain("83%");
      expect(output).toContain("9%");
    }

    expect(outputs.command).toMatch(/Week quota[\s\S]*0% left/u);
    expect(outputs.compact).toContain("5h 83%");
    expect(outputs.compact).toContain("7d 0%");
    expect(outputs.compact).toContain("Monthly 9%");
  });

  it("shows used 100% for a rate-limited window on command, toast, sidebar, and compact", () => {
    const outputs = renderSurfaces({
      entries: exhaustedWeeklyEntries,
      percentDisplayMode: "used",
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("OpenCode Go");
      expect(output).toContain("100%");
      expect(output).toContain("17%");
      expect(output).toContain("91%");
    }

    expect(outputs.command).toMatch(/Week quota[\s\S]*100% used/u);
    expect(outputs.compact).toContain("5h 17%");
    expect(outputs.compact).toContain("7d 100%");
    expect(outputs.compact).toContain("Monthly 91%");
  });

  it("renders only selected windows after provider filtering", () => {
    const selected = exhaustedWeeklyEntries.filter((entry) => entry.label !== "Weekly:");
    const remaining = renderAccountingFourSurfaces({
      data: { entries: selected, errors: [] },
      accountingDetail: "summary",
      toastMaxWidth: 64,
      toastNarrowAt: 44,
      compactMaxWidth: 160,
    });

    for (const output of Object.values(remaining)) {
      expect(output).toContain("83%");
      expect(output).toContain("9%");
      expect(output).not.toMatch(/\b7d\b/u);
      expect(output).not.toMatch(/Week(?:ly)?/u);
    }
    expect(remaining.compact).toContain("5h 83%");
    expect(remaining.compact).toContain("Monthly 9%");
    expect(remaining.compact).not.toContain("7d");
  });
});
