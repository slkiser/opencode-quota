import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaRows } from "../src/lib/format.js";
import { SESSION_TOKEN_SECTION_HEADING } from "../src/lib/session-tokens-format.js";
import {
  buildSidebarQuotaPanelLines,
  TUI_SIDEBAR_LAYOUT,
  TUI_SIDEBAR_MAX_WIDTH,
} from "../src/lib/tui-sidebar-format.js";

describe("buildSidebarQuotaPanelLines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sanitizes structured entry, error, and session-token text before rendering", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "allWindows",
        percentDisplayMode: "remaining",
      },
      data: {
        entries: [
          {
            name: "OpenAI\u001b[31m",
            group: "[OpenAI]\u0007",
            label: "Usage\u001b[0m",
            right: "5/10\u0001",
            percentRemaining: 42,
            resetTimeIso: "2099-01-01T00:00:00.000Z\u0002",
          },
        ],
        errors: [
          {
            label: "Err\u001b[33m",
            message: "Bad\u0003",
          },
        ],
        sessionTokens: {
          totalInput: 12,
          totalOutput: 34,
          models: [
            {
              modelID: "gpt-5\u001b[99m",
              input: 12,
              output: 34,
            },
          ],
        },
      },
    });

    const rendered = lines.join("\n");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).not.toContain("\u0001");
    expect(rendered).not.toContain("\u0002");
    expect(rendered).not.toContain("\u0003");
    expect(rendered).toContain("Err: Bad");
    expect(rendered).toContain(SESSION_TOKEN_SECTION_HEADING);
    expect(rendered).toContain("12 in  34 out");
    expect(rendered).toContain("gpt-5");
  });

  it("uses the fixed sidebar layout instead of toast layout settings", () => {
    const data = {
      entries: [
        {
          name: "Copilot",
          percentRemaining: 75,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    const expected = formatQuotaRows({
      version: "1.0.0",
      layout: TUI_SIDEBAR_LAYOUT,
      entries: data.entries,
      errors: data.errors,
      style: "singleWindow",
      percentDisplayMode: "remaining",
      sessionTokens: data.sessionTokens,
    }).split("\n");

    const lines = buildSidebarQuotaPanelLines({
      data,
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
      },
    });

    expect(lines).toEqual(expected);
    expect(lines.join("\n")).not.toContain("Quota (remaining)");
    expect(lines.join("\n")).not.toContain("Quota (used)");
  });

  it("renders all-window sidebar output via the shared grouped formatter", () => {
    const data = {
      entries: [
        {
          name: "Copilot",
          group: "Copilot (business)",
          label: "Usage:",
          kind: "value" as const,
          value: "9 used | 2026-01 | org=acme-corp",
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    const expected = formatQuotaRows({
      version: "1.0.0",
      layout: TUI_SIDEBAR_LAYOUT,
      entries: data.entries,
      errors: data.errors,
      style: "allWindows",
      percentDisplayMode: "remaining",
      sessionTokens: data.sessionTokens,
    }).split("\n");

    const lines = buildSidebarQuotaPanelLines({
      data,
      config: {
        formatStyle: "allWindows",
        percentDisplayMode: "remaining",
      },
    });

    expect(lines).toEqual(expected);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("[Copilot] (business)");
    expect(lines[1]).toContain("9 used");
    expect(lines.join("\n")).not.toContain("→ ");
    expect(lines.every((line) => line.length <= TUI_SIDEBAR_MAX_WIDTH)).toBe(true);
  });

  it("renders grouped quota windows shortest to longest in the sidebar", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "allWindows",
        percentDisplayMode: "remaining",
      },
      data: {
        entries: [
          {
            name: "Anthropic Weekly",
            group: "Anthropic",
            label: "Weekly:",
            percentRemaining: 81,
          },
          {
            name: "Anthropic 5h",
            group: "Anthropic",
            label: "5h:",
            percentRemaining: 94,
          },
        ],
        errors: [],
        sessionTokens: undefined,
      },
    });

    expect(lines.findIndex((line) => line.includes("5h window"))).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex((line) => line.includes("Weekly window"))).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex((line) => line.includes("5h window"))).toBeLessThan(
      lines.findIndex((line) => line.includes("Weekly window")),
    );
  });

  it("preserves weekly right/percent values in classic sidebar mode", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "used",
      },
      data: {
        entries: [
          {
            name: "Weekly",
            percentRemaining: 8,
            right: "$22/$24",
          },
        ],
        errors: [],
        sessionTokens: undefined,
      },
    });

    const rendered = lines.join("\n");
    expect(rendered).toContain("Weekly $22/$24");
    expect(rendered).toContain("92% used");
    expect(rendered).not.toContain("0/500");
    expect(rendered).not.toContain("0% used");
  });

  it("preserves weekly right/percent values in grouped sidebar mode", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "allWindows",
        percentDisplayMode: "used",
      },
      data: {
        entries: [
          {
            name: "Synthetic Weekly",
            group: "Synthetic",
            label: "Weekly:",
            percentRemaining: 8,
            right: "$22/$24",
          },
        ],
        errors: [],
        sessionTokens: undefined,
      },
    });

    const rendered = lines.join("\n");
    expect(rendered).toContain("[Synthetic]");
    expect(rendered).toContain("Weekly window");
    expect(rendered).not.toContain("$22/$24");
    expect(rendered).toContain("92% used");
    expect(rendered).not.toContain("0/500");
    expect(rendered).not.toContain("0% used");
  });

  it("uses compact rounded reset text in sidebar rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
      },
      data: {
        entries: [
          {
            name: "[Copilot] Monthly",
            percentRemaining: 81,
            resetTimeIso: "2026-01-15T12:14:00.000Z",
          },
        ],
        errors: [],
        sessionTokens: undefined,
      },
    });

    expect(lines.join("\n")).toContain("2h");
    expect(lines.join("\n")).not.toContain("2h 14m");
  });

  it("renders used percentages and matching bar fill in the sidebar", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "used",
      },
      data: {
        entries: [
          {
            name: "Copilot",
            percentRemaining: 81,
            resetTimeIso: "2099-01-01T00:00:00.000Z",
          },
        ],
        errors: [],
        sessionTokens: undefined,
      },
    });

    const barLine = lines[1] ?? "";
    expect(barLine).toContain("19% used");
    expect(barLine).not.toContain("81% left");
    expect(lines.join("\n")).not.toContain("Quota (remaining)");
    expect(lines.join("\n")).not.toContain("Quota (used)");
    expect((barLine.match(/█/g) ?? [])).toHaveLength(5);
  });

  it("renders over-quota used percentages above 100 in the sidebar", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "used",
      },
      data: {
        entries: [
          {
            name: "Copilot",
            percentRemaining: -25,
            resetTimeIso: "2099-01-01T00:00:00.000Z",
          },
        ],
        errors: [],
        sessionTokens: undefined,
      },
    });

    const barLine = lines[1] ?? "";
    expect(barLine).toContain("125% used");
    expect((barLine.match(/░/g) ?? [])).toHaveLength(0);
  });

  it("never shows negative remaining labels in the sidebar", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
      },
      data: {
        entries: [
          {
            name: "Copilot",
            percentRemaining: -25,
            resetTimeIso: "2099-01-01T00:00:00.000Z",
          },
        ],
        errors: [],
        sessionTokens: undefined,
      },
    });

    const barLine = lines[1] ?? "";
    expect(barLine).toContain("0% left");
    expect(barLine).not.toContain("-%");
  });

  it("renders all-window sidebar session tokens with detailed per-model rows", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "allWindows",
        percentDisplayMode: "remaining",
      },
      data: {
        entries: [],
        errors: [],
        sessionTokens: {
          totalInput: 372,
          totalOutput: 41,
          models: [
            {
              modelID: "openai/gpt-5.4-mini",
              input: 372,
              output: 41,
            },
          ],
        },
      },
    });

    expect(lines.every((line) => line.length <= TUI_SIDEBAR_MAX_WIDTH)).toBe(true);
    expect(lines).toEqual([
      SESSION_TOKEN_SECTION_HEADING,
      "  openai/gpt-5.4-mini",
      "    372 in  41 out",
    ]);
  });

  it("renders single-window sidebar session tokens as a standalone one-line summary", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
      },
      data: {
        entries: [],
        errors: [],
        sessionTokens: {
          totalInput: 372,
          totalOutput: 41,
          models: [
            {
              modelID: "openai/gpt-5.4-mini",
              input: 372,
              output: 41,
            },
          ],
        },
      },
    });

    expect(lines.every((line) => line.length <= TUI_SIDEBAR_MAX_WIDTH)).toBe(true);
    expect(lines).toEqual([SESSION_TOKEN_SECTION_HEADING, "  372 in  41 out"]);
  });

  it("keeps value-only rows unchanged when percentDisplayMode is used", () => {
    const data = {
      entries: [
        {
          name: "Cursor API",
          kind: "value" as const,
          value: "$2.40 / $20.00",
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
      errors: [],
      sessionTokens: undefined,
    };

    const remaining = buildSidebarQuotaPanelLines({
      data,
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
      },
    });
    const used = buildSidebarQuotaPanelLines({
      data,
      config: {
        formatStyle: "singleWindow",
        percentDisplayMode: "used",
      },
    });

    expect(used).toEqual(remaining);
    expect(used.join("\n")).toContain("$2.40 / $20.00");
  });
});
