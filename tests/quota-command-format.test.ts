import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";

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
          name: "Copilot",
          group: "Copilot (personal)",
          label: "Quota:",
          right: "42/300",
          percentRemaining: 86,
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
        {
          name: "Copilot",
          group: "Copilot (business)",
          label: "Usage:",
          kind: "value",
          value: "9 used | 2026-01 | org=acme-corp | user=alice",
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
        {
          name: "OpenAI (Pro) Hourly",
          group: "OpenAI (Pro)",
          label: "Hourly:",
          percentRemaining: 42,
          resetTimeIso: "2026-01-15T14:00:00.000Z",
        },
        {
          name: "OpenAI (Pro) Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
          resetTimeIso: "2026-01-18T12:00:00.000Z",
        },
        {
          name: "Claude (acct)",
          percentRemaining: 67,
          resetTimeIso: "2026-01-15T15:00:00.000Z",
        },
      ],
      errors: [{ label: "Z.ai", message: "Authentication expired" }],
      sessionTokens: {
        models: [
          { modelID: "openai/gpt-5", input: 1234, output: 567 },
          { modelID: "github-copilot/claude-sonnet-4.5", input: 987, output: 654 },
        ],
        totalInput: 2221,
        totalOutput: 1221,
      },
    });

    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^# Quota \(\/quota\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/);
    expect(lines[1]).toBe("");
    expect(lines.slice(2).join("\n")).toMatchInlineSnapshot(`
      "→ [Copilot] (personal)
        Quota: 42/300    ███████████████░░░  86% left (resets in 12h)

      → [Copilot] (business)
        Usage:           9 used | 2026-01 | org=acme-corp | user=alice (resets in 17d)

      → [OpenAI] (Pro)
        Hourly:          ████████░░░░░░░░░░  42% left (resets in 2h)
        Weekly:          ███████████████░░░  81% left (resets in 3d)

      → [Google Antigravity] (acct)
        Claude:          ████████████░░░░░░  67% left (resets in 3h)

      Session input/output tokens
        openai/gpt-5            1.2K in     567 out
        github-copilot/clau…     987 in     654 out

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
          name: "OpenAI Hourly",
          group: "OpenAI (Pro)",
          label: "Hourly:",
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

    expect(out.indexOf("Hourly:")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Weekly:")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Code Review:")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Hourly:")).toBeLessThan(out.indexOf("Weekly:"));
    expect(out.indexOf("Weekly:")).toBeLessThan(out.indexOf("Code Review:"));
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
          name: "OpenAI Hourly",
          group: "OpenAI (Pro)",
          label: "Hourly:",
          percentRemaining: 42,
        },
      ],
      errors: [],
    });

    expect(out.indexOf("→ [Qwen] (free)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("→ [OpenAI] (Pro)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("→ [Qwen] (free)")).toBeLessThan(out.indexOf("→ [OpenAI] (Pro)"));

    expect(out.indexOf("RPM:")).toBeLessThan(out.indexOf("Daily:"));
    expect(out.indexOf("Hourly:")).toBeLessThan(out.indexOf("Weekly:"));
  });

  it("sizes the grouped /quota label column from the visible grouped text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
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

    expect(out).toContain("Quota: 12345678901234567890");
  });
});
