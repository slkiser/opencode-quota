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
        acquisitionMethod: "dashboard_scrape",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "Xiaomi MiMo Monthly",
      group: "Xiaomi MiMo",
      label: "Monthly:",
      right: "25/100",
      percentRemaining: 75,
    },
    {
      accounting: {
        resultType: "balance",
        acquisitionMethod: "dashboard_scrape",
        ownership: "maintained",
        authority: "provider_reported",
      },
      kind: "value",
      name: "Xiaomi MiMo Total Balance",
      group: "Xiaomi MiMo",
      label: "Total:",
      value: "$12.50",
    },
  ],
  errors: [],
};

describe("Xiaomi MiMo four-surface formatting", () => {
  it("shows monthly quota and balance in Web, toast, TUI sidebar, and Compact output", () => {
    const web = formatQuotaCommand({ ...data, generatedAtMs: 0 });
    const toast = formatQuotaRowsGrouped(data);
    const sidebar = buildSidebarQuotaPanelLines({
      data,
      config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
    }).join("\n");
    const compact = buildCompactQuotaStatusLine({
      data,
      percentDisplayMode: "remaining",
      maxWidth: 240,
    });

    for (const output of [web, toast, sidebar, compact]) {
      expect(output).toContain("Xiaomi MiMo");
      expect(output).toContain("75%");
      expect(output).toContain("$12.50");
    }
  });
});
