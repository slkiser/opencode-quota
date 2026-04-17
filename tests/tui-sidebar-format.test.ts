import { describe, expect, it } from "vitest";

import { formatQuotaRows } from "../src/lib/format.js";
import { SESSION_TOKEN_SECTION_HEADING } from "../src/lib/session-tokens-format.js";
import {
  buildSidebarQuotaPanelLines,
  TUI_SIDEBAR_LAYOUT,
  TUI_SIDEBAR_MAX_WIDTH,
} from "../src/lib/tui-sidebar-format.js";

describe("buildSidebarQuotaPanelLines", () => {
  it("sanitizes structured entry, error, and session-token text before rendering", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "grouped",
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
    expect(rendered).not.toContain("gpt-5");
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
      style: "classic",
      sessionTokens: data.sessionTokens,
    }).split("\n");

    expect(
      buildSidebarQuotaPanelLines({
        data,
        config: {
          formatStyle: "classic",
        },
      }),
    ).toEqual(expected);
  });

  it("renders grouped sidebar output via the shared grouped formatter", () => {
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
      style: "grouped",
      sessionTokens: data.sessionTokens,
    }).split("\n");

    const lines = buildSidebarQuotaPanelLines({
      data,
      config: {
        formatStyle: "grouped",
      },
    });

    expect(lines).toEqual(expected);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("→ [Copilot] (business)");
    expect(lines.every((line) => line.length <= TUI_SIDEBAR_MAX_WIDTH)).toBe(true);
  });

  it("renders grouped quota windows shortest to longest in the sidebar", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "grouped",
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

    expect(lines.findIndex((line) => line.includes("5h:"))).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex((line) => line.includes("Weekly:"))).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex((line) => line.includes("5h:"))).toBeLessThan(
      lines.findIndex((line) => line.includes("Weekly:")),
    );
  });

  it("renders sidebar session tokens as a standalone one-line summary", () => {
    const lines = buildSidebarQuotaPanelLines({
      config: {
        formatStyle: "classic",
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
});
