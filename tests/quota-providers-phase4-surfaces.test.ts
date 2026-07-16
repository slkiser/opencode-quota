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
        ownership: "user_configured",
        authority: "provider_reported",
        sourceId: "source-one",
      },
      name: "Duplicate label",
      group: "Duplicate label",
      label: "Weekly:",
      percentRemaining: 10,
      resetTimeIso: "2099-08-01T00:00:00.000Z",
    },
    {
      accounting: {
        resultType: "balance",
        acquisitionMethod: "remote_api",
        ownership: "user_configured",
        authority: "provider_reported",
        sourceId: "source-two",
      },
      name: "Duplicate label",
      group: "Duplicate label",
      label: "Balance:",
      kind: "value",
      value: "$4.00",
    },
  ],
  errors: [{ label: "Duplicate label", message: "one source unavailable" }],
};

describe("quota provider four-surface formatting", () => {
  it("keeps duplicate-label percent/value rows and partial errors in generic formatters", () => {
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

    expect(command).toMatch(/^# Quota \(\/quota\)/);
    expect(command).not.toContain("```");
    expect(command).toMatch(/→ \[Duplicate label\]\n\n {4}Week quota/u);
    const providerRows = command
      .split("\n")
      .filter((line) => line.includes("Week quota") || line.includes("Balance"));
    expect(providerRows).toHaveLength(2);
    expect(providerRows.every((line) => /^ {4}\S/u.test(line))).toBe(true);
    const bars = command.match(/[█░]+/gu) ?? [];
    expect(bars).toHaveLength(1);
    expect(Array.from(bars[0]!)).toHaveLength(10);
    expect(command).toMatch(/Week quota\s+[█░]{10}\s+10% left · reset /);
    expect(command).toMatch(/Balance\s+\$4\.00/);

    for (const output of [command, toast, sidebar, compact]) {
      expect(output).toContain("10%");
      expect(output).toContain("$4.00");
    }
    expect(command).toContain("one source unavailable");
    expect(toast).toContain("one source unavailable");
    expect(sidebar).toContain("one source unavailable");
    expect(compact).toContain("issue");
  });
});
