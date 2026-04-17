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
    expect(out).toContain("75%");
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
});
