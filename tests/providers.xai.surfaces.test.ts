import { describe, expect, it } from "vitest";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const xaiLabels = ["xAI Lite", "xAI SuperGrok", "xAI Heavy"] as const;

function renderDataForLabel(label: (typeof xaiLabels)[number]): QuotaRenderData {
  return {
    entries: [
      {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: `${label} Weekly`,
        group: label,
        label: "Weekly:",
        percentRemaining: 95,
        resetTimeIso: "2099-08-01T00:00:00.000Z",
      },
    ],
    errors: [],
  };
}

describe("xAI four-surface formatting", () => {
  it.each([
    ["[xAI] (SuperGrok)*"],
    ["[xAI personal] (SuperGrok)*"],
  ])("preserves the credential group %s on command, toast, and sidebar", (group) => {
    const data: QuotaRenderData = {
      entries: [
        {
          ...renderDataForLabel("xAI SuperGrok").entries[0]!,
          name: `${group} Weekly`,
          group,
        },
      ],
      errors: [],
    };
    const outputs = [
      formatQuotaCommand({ ...data, generatedAtMs: 0 }),
      formatQuotaRowsGrouped(data),
      buildSidebarQuotaPanelLines({
        data,
        config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
      }).join("\n"),
    ];

    for (const output of outputs) expect(output).toContain(group);
  });

  it.each(
    xaiLabels,
  )("shows the %s weekly quota in command, toast, sidebar, and compact output", (label) => {
    const data = renderDataForLabel(label);
    const command = formatQuotaCommand({ ...data, generatedAtMs: 0 });
    const toast = formatQuotaRowsGrouped(data);
    const sidebar = buildSidebarQuotaPanelLines({
      data,
      config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
    }).join("\n");
    const compact = buildCompactQuotaStatusLine({
      data,
      percentDisplayMode: "remaining",
      maxWidth: 200,
    });

    for (const output of [command, toast, sidebar, compact]) {
      expect(output).toContain("95%");
      expect(output).toContain(label);
    }
  });
});
