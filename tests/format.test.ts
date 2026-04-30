import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaRows } from "../src/lib/format.js";
import { SESSION_TOKEN_SECTION_HEADING } from "../src/lib/session-tokens-format.js";

describe("formatQuotaRows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a Copilot row", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Copilot",
          percentRemaining: 75,
          resetTimeIso: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("Copilot");
    expect(out).toContain("75% left");
    expect(out).not.toContain("Quota (remaining)");
    expect(out).not.toContain("Quota (used)");
  });

  it("uses tiny layout when maxWidth is small", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 28, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Copilot",
          percentRemaining: 100,
          resetTimeIso: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // Tiny layout is single-line per entry (no bar characters)
    expect(out).toContain("Copilot");
    expect(out).not.toContain("█");
  });

  it("renders classic percent rows as used when percentDisplayMode is used", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 24, narrowAt: 16, tinyAt: 10 },
      percentDisplayMode: "used",
      entries: [
        {
          name: "Copilot",
          percentRemaining: 81,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    const lines = out.split("\n");
    const barLine = lines[1] ?? "";
    expect(barLine).toContain("19% used");
    expect(barLine).not.toContain("81% left");
    expect(out).not.toContain("Quota (remaining)");
    expect(out).not.toContain("Quota (used)");
    expect((barLine.match(/█/g) ?? [])).toHaveLength(2);
  });

  it("renders over-quota percentages above 100 in used mode", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 32, narrowAt: 24, tinyAt: 16 },
      percentDisplayMode: "used",
      entries: [
        {
          name: "Copilot",
          percentRemaining: -25,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    const lines = out.split("\n");
    const barLine = lines[1] ?? "";
    expect(barLine).toContain("125% used");
    expect((barLine.match(/░/g) ?? [])).toHaveLength(0);
  });

  it("floors over-quota remaining labels at 0% left", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 32, narrowAt: 24, tinyAt: 16 },
      percentDisplayMode: "remaining",
      entries: [
        {
          name: "Copilot",
          percentRemaining: -25,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    const lines = out.split("\n");
    const barLine = lines[1] ?? "";
    expect(barLine).toContain("0% left");
    expect((barLine.match(/█/g) ?? [])).toHaveLength(0);
  });

  it("renders percent-row usage summaries in classic output when providers supply them", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Synthetic",
          right: "0/135",
          percentRemaining: 100,
        },
        {
          name: "Qwen RPM",
          right: "5/60",
          percentRemaining: 92,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("Synthetic");
    expect(out).toContain("0/135");
    expect(out).toContain("Qwen RPM");
    expect(out).toContain("5/60");
    expect(out).toContain("92% left");
  });

  it("shows reset countdown when quota is partially used", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Copilot",
          percentRemaining: 75,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    // We don't assert exact time math; just that some countdown marker appears.
    expect(out).toMatch(/(\d+[dhms]|reset)/);
  });

  it("does not show reset countdown when quota is fully available", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Copilot",
          percentRemaining: 100,
          resetTimeIso: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(out).not.toMatch(/\d+[dhms]/);
  });

  it("uses compact rounded reset labels for single-window rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "[Copilot] Monthly",
          percentRemaining: 56,
          resetTimeIso: "2026-01-15T12:14:00.000Z",
        },
      ],
    });

    expect(out).toContain("2h");
    expect(out).not.toContain("2h 14m");
  });

  it("uses compact rounded reset labels for grouped rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "OpenAI 5h",
          group: "OpenAI",
          label: "5h:",
          percentRemaining: 56,
          resetTimeIso: "2026-01-15T10:14:00.000Z",
        },
      ],
    });

    expect(out).toContain("14m");
    expect(out).not.toContain("0h 14m");
  });

  it("normalizes grouped headers in all-window toast output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 80, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Copilot",
          group: "Copilot (business)",
          label: "Usage:",
          kind: "value",
          value: "9 used | 2026-01 | org=acme-corp",
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("[Copilot] (business)");
    expect(out).not.toContain("→ ");
  });

  it("preserves grouped value-row labels and values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 80, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Copilot",
          group: "Copilot (business)",
          label: "Usage:",
          kind: "value",
          value: "9 used | 2026-01 | org=acme-corp",
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("Usage:");
    expect(out).toContain("9 used | 2026-01 | org=acme-corp");
    expect(out).not.toContain("Quota window");
  });

  it("renders grouped-header provider + window label in direct single-window formatter calls", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Copilot",
          group: "Copilot (personal)",
          label: "Monthly:",
          percentRemaining: 86,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("[Copilot] (personal) Monthly");
  });

  it("does not double-append window labels when single-window names are already preformatted", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "[Copilot] (personal) Monthly",
          label: "Monthly:",
          percentRemaining: 86,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("[Copilot] (personal) Monthly");
    expect(out).not.toContain("Monthly Monthly");
  });

  it("renders all-window quota entries from shortest to longest within a provider group", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "OpenAI Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 88,
        },
        {
          name: "OpenAI 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 92,
        },
      ],
    });

    expect(out.indexOf("5h window")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Weekly window")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("5h window")).toBeLessThan(out.indexOf("Weekly window"));
  });

  it("renders all-window percent rows as used when percentDisplayMode is used", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 24, narrowAt: 16, tinyAt: 10 },
      percentDisplayMode: "used",
      entries: [
        {
          name: "OpenAI Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

    const barLine = out
      .split("\n")
      .find((line) => line.includes("%"));
    expect(barLine).toContain("19% used");
    expect(barLine).not.toContain("81% left");
    expect(out).not.toContain("Quota (remaining)");
    expect(out).not.toContain("Quota (used)");
    expect((barLine?.match(/█/g) ?? [])).toHaveLength(2);
  });

  it("renders all-window percent-row usage summaries when providers supply them", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Synthetic 5h",
          group: "Synthetic",
          label: "5h:",
          right: "0/135",
          percentRemaining: 100,
        },
      ],
    });

    expect(out).toContain("5h window");
    expect(out).not.toContain("0/135");
    expect(out).toContain("100% left");
  });

  it("locks rendered all-window toast ordering for Qwen and OpenAI provider groups", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Qwen Free Daily",
          group: "Qwen (free)",
          label: "Daily:",
          percentRemaining: 90,
        },
        {
          name: "OpenAI Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
        },
        {
          name: "Qwen Free RPM",
          group: "Qwen (free)",
          label: "RPM:",
          percentRemaining: 60,
        },
        {
          name: "OpenAI 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 42,
        },
      ],
    });

    expect(out.indexOf("[Qwen] (free)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("[OpenAI] (Pro)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("[Qwen] (free)")).toBeLessThan(out.indexOf("[OpenAI] (Pro)"));

    expect(out.indexOf("RPM window")).toBeLessThan(out.indexOf("Daily window"));
    expect(out.indexOf("5h window")).toBeLessThan(out.indexOf("Weekly window"));
  });

  it("groups legacy Google-style entries without duplicating the header text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Claude (acct)",
          percentRemaining: 67,
          resetTimeIso: "2026-01-15T15:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("[Google Antigravity] (acct)");
    expect(out).toContain("Quota window");
    expect(out).not.toContain("[Claude] (acct)");
  });

  it("renders single-window session tokens as a one-line total summary", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "singleWindow",
      layout: { maxWidth: 36, narrowAt: 32, tinyAt: 20 },
      entries: [],
      sessionTokens: {
        totalInput: 372,
        totalOutput: 41,
        models: [{ modelID: "openai/gpt-5.4-mini", input: 372, output: 41 }],
      },
    });

    expect(out.split("\n")).toEqual([SESSION_TOKEN_SECTION_HEADING, "  372 in  41 out"]);
    expect(out).not.toContain("openai/gpt-5.4-mini");
  });

  it("renders all-window session tokens with detailed per-model rows", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 36, narrowAt: 32, tinyAt: 20 },
      entries: [],
      sessionTokens: {
        totalInput: 372,
        totalOutput: 41,
        models: [{ modelID: "openai/gpt-5.4-mini", input: 372, output: 41 }],
      },
    });

    expect(out.split("\n")).toEqual([
      SESSION_TOKEN_SECTION_HEADING,
      "  openai/gpt-5.4-mini",
      "    372 in  41 out",
    ]);
  });

  it("keeps legacy style aliases working for direct formatter calls", () => {
    const aliasOutput = formatQuotaRows({
      version: "1.0.0",
      style: "grouped",
      layout: { maxWidth: 36, narrowAt: 32, tinyAt: 20 },
      entries: [],
      sessionTokens: {
        totalInput: 372,
        totalOutput: 41,
        models: [{ modelID: "openai/gpt-5.4-mini", input: 372, output: 41 }],
      },
    });

    const canonicalOutput = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 36, narrowAt: 32, tinyAt: 20 },
      entries: [],
      sessionTokens: {
        totalInput: 372,
        totalOutput: 41,
        models: [{ modelID: "openai/gpt-5.4-mini", input: 372, output: 41 }],
      },
    });

    expect(aliasOutput).toBe(canonicalOutput);
  });

  it("does not change value-only rows when percentDisplayMode changes", () => {
    const params = {
      version: "1.0.0",
      layout: { maxWidth: 40, narrowAt: 32, tinyAt: 20 },
      entries: [
        {
          name: "Cursor API",
          kind: "value" as const,
          value: "$2.40 / $20.00",
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
    };

    const remaining = formatQuotaRows({
      ...params,
      percentDisplayMode: "remaining",
    });
    const used = formatQuotaRows({
      ...params,
      percentDisplayMode: "used",
    });

    expect(used).toBe(remaining);
    expect(used).toContain("$2.40 / $20.00");
    expect(used).not.toContain("% left");
    expect(used).not.toContain("% used");
  });
});
