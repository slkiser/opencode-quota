import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaRows } from "../src/lib/format.js";

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

  it("renders session request counts under the shared session token block", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Copilot",
          percentRemaining: 75,
        },
      ],
      sessionTokens: {
        models: [{ modelID: "openai/gpt-5.4-mini", input: 372, output: 41 }],
        totalInput: 372,
        totalOutput: 41,
        requestCount: 3,
      },
    });

    expect(out).toContain("Session input/output tokens");
    expect(out).toMatch(/372 in\s+41 out/);
    expect(out).toContain("(3 requests this session)");
  });

  it("normalizes grouped headers in grouped toast output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaRows({
      version: "1.0.0",
      style: "grouped",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
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

    expect(out).toContain("→ [Copilot] (business)");
  });

  it("renders grouped quota windows from shortest to longest within a provider group", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "grouped",
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

    expect(out.indexOf("5h:")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Weekly:")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("5h:")).toBeLessThan(out.indexOf("Weekly:"));
  });

  it("renders grouped percent rows as used when percentDisplayMode is used", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "grouped",
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

  it("renders grouped percent-row usage summaries when providers supply them", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "grouped",
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

    expect(out).toContain("5h: 0/135");
    expect(out).toContain("100% left");
  });

  it("locks rendered grouped toast ordering for Qwen and OpenAI provider groups", () => {
    const out = formatQuotaRows({
      version: "1.0.0",
      style: "grouped",
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
          name: "OpenAI Hourly",
          group: "OpenAI (Pro)",
          label: "Hourly:",
          percentRemaining: 42,
        },
      ],
    });

    expect(out.indexOf("→ [Qwen] (free)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("→ [OpenAI] (Pro)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("→ [Qwen] (free)")).toBeLessThan(out.indexOf("→ [OpenAI] (Pro)"));

    expect(out.indexOf("RPM:")).toBeLessThan(out.indexOf("Daily:"));
    expect(out.indexOf("Hourly:")).toBeLessThan(out.indexOf("Weekly:"));
  });

  it("groups legacy Google-style entries without duplicating the header text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaRows({
      version: "1.0.0",
      style: "grouped",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries: [
        {
          name: "Claude (acct)",
          percentRemaining: 67,
          resetTimeIso: "2026-01-15T15:00:00.000Z",
        },
      ],
    });

    expect(out).toContain("→ [Google Antigravity] (acct)");
    expect(out).toContain("Claude:");
    expect(out).not.toContain("→ [Claude] (acct)");
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
