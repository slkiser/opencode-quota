import { describe, expect, it } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const accounting = {
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const data: QuotaRenderData = {
  entries: [
    {
      accounting: { resultType: "quota", ...accounting },
      name: "Ollama Cloud Session",
      group: "Ollama Cloud",
      label: "Session:",
      percentRemaining: 75,
    },
    {
      accounting: { resultType: "quota", ...accounting },
      name: "Ollama Cloud Weekly",
      group: "Ollama Cloud",
      label: "Weekly:",
      percentRemaining: 60,
    },
    {
      kind: "value",
      accounting: { resultType: "usage", ...accounting },
      name: "Ollama Cloud qwen3",
      group: "Ollama Cloud",
      label: "qwen3:",
      metricLabel: "qwen3",
      value: "12 requests",
    },
  ],
  errors: [],
};

describe("Ollama Cloud four-surface formatting", () => {
  it("shows Ollama Cloud quota on command, toast, sidebar, and compact output", () => {
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
      expect(output).toContain("Ollama Cloud");
      expect(output).toContain("75%");
    }

    expect(command).toContain("qwen3");
    for (const output of [command, toast, sidebar]) {
      expect(output).toContain("12 requests");
    }
  });
});
