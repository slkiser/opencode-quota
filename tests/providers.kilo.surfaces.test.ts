import { describe, expect, it } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const data: QuotaRenderData = {
  entries: [
    {
      kind: "value",
      accounting: {
        resultType: "balance",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "Kilo Gateway Balance",
      group: "Kilo Gateway",
      label: "Balance:",
      value: "$12.34",
    },
  ],
  errors: [],
};

describe("Kilo Gateway four-surface formatting", () => {
  it("shows the documented balance without inventing quota or reset data", () => {
    const web = formatQuotaCommand({ ...data, generatedAtMs: 0 });
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

    for (const output of [web, toast, sidebar, compact]) {
      expect(output).toContain("Kilo Gateway");
      expect(output).toContain("$12.34");
      expect(output).not.toContain("%");
      expect(output.toLowerCase()).not.toContain("reset");
    }
  });
});
