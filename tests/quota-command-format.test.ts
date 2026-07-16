import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaCommand, QUOTA_COMMAND_BAR_WIDTH } from "../src/lib/quota-command-format.js";

function accounting(
  resultType: "quota" | "rate_limit" | "usage" | "spend" | "budget" | "balance" | "status",
) {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority: "provider_reported",
  } as const;
}

describe("formatQuotaCommand", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("documents the main /quota printout combinations used by the default command output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Copilot",
          group: "Copilot (personal)",
          label: "Quota:",
          right: "42/300",
          percentRemaining: 86,
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
        {
          accounting: accounting("usage"),
          name: "Copilot",
          group: "Copilot (business)",
          label: "Usage:",
          kind: "value",
          value: "9 used | 2026-01 | org=acme-corp | user=alice",
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "OpenAI (Pro) 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 42,
          resetTimeIso: "2026-01-15T14:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "OpenAI (Pro) Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
          resetTimeIso: "2026-01-18T12:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "Claude (acct)",
          percentRemaining: 67,
          resetTimeIso: "2026-01-15T15:00:00.000Z",
        },
      ],
      errors: [{ label: "Z.ai", message: "Authentication expired" }],
      sessionTokens: {
        models: [
          { modelID: "openai/gpt-5", input: 1234, cachedInput: 456, totalInput: 1690, output: 567 },
          { modelID: "github-copilot/claude-sonnet-4.5", input: 987, output: 654 },
        ],
        totalInput: 2221,
        totalCachedInput: 456,
        totalCombinedInput: 2677,
        totalOutput: 1221,
      },
    });

    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^# Quota \(\/quota\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/);
    expect(lines[1]).toBe("");
    expect(out).not.toContain("```");
    expect(out.match(/[█░]{10}/gu)).toHaveLength(4);
    expect(lines.slice(2).join("\n")).toMatchInlineSnapshot(`
      "→ [Copilot] (personal)
        Quota         █████████░   86% left · 42/300 · reset 12h

      → [Copilot] (business)
        Usage         9 used | 2026-01 | org=acme-corp | user=alice · reset 17d

      → [OpenAI] (Pro)
        5h quota      ████░░░░░░   42% left · reset 2h
        Week quota    ████████░░   81% left · reset 3d

      → [Google Antigravity] (acct)
        Quota         ███████░░░   67% left · reset 3h

      Session input/output tokens
        openai/gpt-5: 1.2K in · 456 cached · 567 out
        github-copilot/claude-sonnet-4.5: 987 in · 654 out

      Partial failures
        Z.ai: Authentication expired"
    `);
  });

  it("renders grouped /quota windows shortest to longest within a provider group", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          name: "OpenAI Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
        },
        {
          name: "OpenAI 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 42,
        },
        {
          name: "OpenAI Code Review",
          group: "OpenAI (Pro)",
          label: "Code Review:",
          kind: "value" as const,
          value: "2 used",
        },
      ],
      errors: [],
    });

    expect(out.indexOf("5h quota")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Week quota")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Code Review")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("5h quota")).toBeLessThan(out.indexOf("Week quota"));
    expect(out.indexOf("Week quota")).toBeLessThan(out.indexOf("Code Review"));
  });

  it("locks rendered grouped /quota ordering for Qwen and OpenAI provider groups", () => {
    const out = formatQuotaCommand({
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
      errors: [],
    });

    expect(out.indexOf("→ [Qwen] (free)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("→ [OpenAI] (Pro)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("→ [Qwen] (free)")).toBeLessThan(out.indexOf("→ [OpenAI] (Pro)"));

    expect(out.indexOf("RPM quota")).toBeLessThan(out.indexOf("Day quota"));
    expect(out.indexOf("5h quota")).toBeLessThan(out.indexOf("Week quota"));
  });

  it("honors used percent display mode in /quota percent rows", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          name: "OpenAI Pro",
          percentRemaining: 81,
        },
      ],
      errors: [],
      percentDisplayMode: "used",
    });

    expect(out).toContain("Status        ██░░░░░░░░   19% used");
    expect(out).not.toContain("81% left");
  });

  it("clamps the bar but preserves over-quota used percentage meaning", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          name: "OpenAI Pro",
          percentRemaining: -25,
        },
      ],
      errors: [],
      percentDisplayMode: "used",
    });

    expect(out).toContain("Status        ██████████  125% used");
  });

  it("uses fixed semantic labels and an aligned 10-cell monospaced bar contract", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Example daily quota",
          group: "Example",
          label: "Daily:",
          right: "20/100",
          percentRemaining: 80,
        },
        {
          accounting: accounting("budget"),
          name: "Example daily budget",
          group: "Example",
          label: "Daily:",
          right: "$4/$20",
          percentRemaining: 80,
        },
        {
          accounting: accounting("balance"),
          name: "Example balance",
          group: "Example",
          label: "Account:",
          kind: "value",
          value: "$42.00",
        },
      ],
      errors: [],
    });

    expect(out).toContain("Day quota");
    expect(out).toContain("Day budget");
    expect(out).toContain("Balance");

    const percentLines = out.split("\n").filter((line) => /[█░]/u.test(line));
    const bars = percentLines.map((line) => line.match(/[█░]+/u)![0]);
    expect(bars.map((value) => Array.from(value).length)).toEqual([
      QUOTA_COMMAND_BAR_WIDTH,
      QUOTA_COMMAND_BAR_WIDTH,
    ]);
    expect(percentLines.map((line) => line.search(/[█░]/u))).toEqual([16, 16]);
    expect(Math.max(...percentLines.map((line) => Array.from(line).length))).toBeLessThanOrEqual(
      64,
    );
  });

  it("keeps /quota reset formatting independent from compact toast resets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          name: "OpenAI",
          group: "OpenAI",
          label: "Weekly:",
          percentRemaining: 81,
          resetTimeIso: "2026-01-15T12:40:00.000Z",
        },
      ],
      errors: [],
    });

    // /quota keeps its own formatter (hour-rounded here), not toast compact rounding.
    expect(out).toContain("reset 3h");
  });

  it("aligns reset columns when usage values have different widths", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Local Rolling",
          group: "Local",
          label: "5h:",
          right: "2/5",
          percentRemaining: 60,
          resetTimeIso: "2026-01-15T17:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "Local Daily",
          group: "Local",
          label: "Daily:",
          right: "2/10",
          percentRemaining: 80,
          resetTimeIso: "2026-01-15T23:00:00.000Z",
        },
      ],
      errors: [],
    });

    const metricLines = out.split("\n").filter((line) => line.includes(" · reset "));
    expect(metricLines).toHaveLength(2);
    expect(metricLines[0]).toContain(" · 2/5  · reset 5h");
    expect(metricLines[1]).toContain(" · 2/10 · reset 11h");
    expect(metricLines.map((line) => line.indexOf("reset"))).toEqual([
      metricLines[0]!.indexOf("reset"),
      metricLines[0]!.indexOf("reset"),
    ]);
  });

  it("keeps a representative long /quota metric on one viewport-safe line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Copilot",
          group: "Copilot (personal)",
          label: "Quota:",
          right: "12345678901234567890",
          percentRemaining: 86,
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
      ],
      errors: [],
    });

    const metric = out.split("\n").find((line) => line.includes("12345678901234567890"))!;
    expect(metric).toContain(
      "Quota         █████████░   86% left · 12345678901234567890 · reset 12h",
    );
    expect(Array.from(metric).length).toBeLessThanOrEqual(76);
  });
});
