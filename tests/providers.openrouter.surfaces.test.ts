import { describe, expect, it } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const data: QuotaRenderData = {
  entries: [
    {
      accounting: {
        resultType: "budget",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "OpenRouter budget",
      group: "OpenRouter",
      label: "Budget:",
      percentRemaining: 80,
      right: "$2.00/$10.00",
    },
  ],
  errors: [],
};

describe("OpenRouter four-surface formatting", () => {
  it("shows OpenRouter budget on command, toast, sidebar, and compact output", () => {
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
      expect(output).toContain("OpenRouter");
      expect(output).toContain("80%");
      expect(output).not.toContain("reset");
    }
  });
});
