import { describe, expect, it } from "vitest";

import type { QuotaRenderData } from "../src/lib/quota-render-data.js";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const data: QuotaRenderData = {
  entries: [
    {
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "xAI SuperGrok Weekly",
      group: "xAI SuperGrok",
      label: "Weekly:",
      percentRemaining: 95,
      resetTimeIso: "2099-08-01T00:00:00.000Z",
    },
  ],
  errors: [],
};

describe("xAI four-surface formatting", () => {
  it("shows the weekly quota in command, toast, sidebar, and compact output", () => {
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
    }
    expect(command).toContain("xAI SuperGrok");
    expect(toast).toContain("xAI SuperGrok");
    expect(sidebar).toContain("xAI SuperGrok");
    expect(compact).toContain("xAI SuperGrok");
  });
});
