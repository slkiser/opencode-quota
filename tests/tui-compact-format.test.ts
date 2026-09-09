import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";

describe("buildCompactQuotaStatusLine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats provider reset timestamps to the exact minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    const line = buildCompactQuotaStatusLine({
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "OpenAI Weekly",
            percentRemaining: 50,
            resetTimeIso: "2026-01-17T15:14:00.000Z",
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("OpenAI Weekly 50% 2d5h14m");
  });

  it("renders expired provider resets once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    const line = buildCompactQuotaStatusLine({
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "OpenAI Weekly",
            percentRemaining: 50,
            resetTimeIso: "2026-01-15T09:59:00.000Z",
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("OpenAI Weekly 50% reset");
  });

  it("keeps compact entries without provider reset timestamps unchanged", () => {
    const line = buildCompactQuotaStatusLine({
      maxWidth: 96,
      data: {
        entries: [{ name: "OpenAI Weekly", percentRemaining: 50 }],
        errors: [],
      },
    });

    expect(line).toBe("OpenAI Weekly 50%");
  });

  it("formats percent entries with text-only remaining percent semantics", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot rolling window",
            group: "Copilot",
            label: "5h:",
            percentRemaining: 82,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Copilot 82%");
  });

  it("formats used percent mode with text-only percentages", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "used",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot rolling window",
            group: "Copilot",
            label: "5h:",
            percentRemaining: 82,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Copilot 18%");
  });

  it("keeps a lone Antigravity model label in all-window compact output", () => {
    const line = buildCompactQuotaStatusLine({
      data: {
        entries: [
          {
            name: "Antigravity (ali…): Claude",
            group: "[Antigravity (ali…)]",
            label: "Claude:",
            percentRemaining: 64,
          },
          {
            name: "Antigravity (bob…): Claude",
            group: "[Antigravity (bob…)]",
            label: "Claude:",
            percentRemaining: 37,
          },
        ],
        errors: [],
      },
      maxWidth: 160,
    });

    expect(line).toBe("Antigravity (ali…): Claude 64% | Antigravity (bob…): Claude 37%");
  });

  it("preserves Gemini CLI model tiers in grouped compact status", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          { name: "Gemini Pro", group: "Gemini CLI", label: "Gemini Pro:", percentRemaining: 20 },
          {
            name: "Gemini Flash",
            group: "Gemini CLI",
            label: "Gemini Flash:",
            percentRemaining: 50,
          },
          {
            name: "Gemini Flash Lite",
            group: "Gemini CLI",
            label: "Gemini Flash Lite:",
            percentRemaining: 10,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Gemini CLI: Gemini Pro 20%, Gemini Flash 50%, Gemini Flash Lite 10%");
  });

  it("preserves explicit non-duration compact labels when multiple rows share a provider", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          { name: "Cursor API", group: "Cursor", label: "API:", percentRemaining: 25 },
          { name: "Cursor Requests", group: "Cursor", label: "Requests:", percentRemaining: 50 },
          { name: "Kimi Code Fast", group: "Kimi Code", label: "Fast:", percentRemaining: 80 },
          { name: "Kimi Code Slow", group: "Kimi Code", label: "Slow:", percentRemaining: 40 },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Cursor: API 25%, Requests 50% | Kimi Code: Fast 80%, Slow 40%");
  });

  it("groups multiple percent windows under one provider with compact window labels", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "OpenAI rolling window",
            group: "OpenAI (pro)",
            label: "5h:",
            percentRemaining: 100,
          },
          {
            name: "OpenAI weekly window",
            group: "OpenAI (pro)",
            label: "Weekly:",
            percentRemaining: 100,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("OpenAI Pro 5h 100%, 7d 100%");
  });

  it("keeps compact status provider labels intentionally short", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot rolling window",
            group: "Copilot (personal)",
            label: "5h:",
            percentRemaining: 75,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Copilot 75%");
    expect(line).not.toContain("[Copilot] (personal)");
  });

  it("formats value entries without percent mode changing the value", () => {
    const remaining = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            kind: "value",
            name: "Cursor API",
            value: "$2.40 / $20.00",
          },
        ],
        errors: [],
      },
    });
    const used = buildCompactQuotaStatusLine({
      percentDisplayMode: "used",
      maxWidth: 96,
      data: {
        entries: [
          {
            kind: "value",
            name: "Cursor API",
            value: "$2.40 / $20.00",
          },
        ],
        errors: [],
      },
    });

    expect(remaining).toBe("Cursor API - $2.40 / $20.00");
    expect(used).toBe(remaining);
  });

  it("joins multiple entry and session-token aggregate segments", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot rolling window",
            group: "Copilot",
            label: "5h:",
            percentRemaining: 82,
          },
          {
            kind: "value",
            name: "Cursor API",
            value: "$2.40",
          },
        ],
        errors: [],
        sessionTokens: {
          models: [
            {
              modelID: "openai/gpt-5",
              input: 12_400,
              cachedInput: 5_600,
              totalInput: 18_000,
              output: 3_100,
            },
          ],
          totalInput: 12_400,
          totalCachedInput: 5_600,
          totalCombinedInput: 18_000,
          totalOutput: 3_100,
        },
      },
    });

    expect(line).toBe("Copilot 82% | Cursor API - $2.40 | tok 12.4K (5.6K) in / 3.1K out");
  });

  it("summarizes errors as issue counts when quota segments exist and the count fits", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot",
            percentRemaining: 75,
          },
        ],
        errors: [
          { label: "OpenAI", message: "Not configured" },
          { label: "Cursor", message: "Unavailable" },
        ],
      },
    });

    expect(line).toBe("Copilot 75% | +2 issues");
  });

  it("does not count providers intentionally excluded by current-model filtering", () => {
    const line = buildCompactQuotaStatusLine({
      maxWidth: 96,
      data: {
        entries: [{ name: "OpenAI", percentRemaining: 75 }],
        errors: [
          {
            kind: "intentional-filter",
            label: "xAI",
            message: "Skipped (current model: gpt-5.6-sol)",
          },
          {
            kind: "intentional-filter",
            label: "Ollama Cloud",
            message: "Skipped (current model: gpt-5.6-sol)",
          },
          {
            kind: "intentional-filter",
            label: "OpenRouter",
            message: "Skipped (current model: gpt-5.6-sol)",
          },
        ],
      },
    });

    expect(line).toBe("OpenAI 75%");
  });

  it("still counts genuine errors alongside intentional current-model filtering", () => {
    const line = buildCompactQuotaStatusLine({
      maxWidth: 96,
      data: {
        entries: [{ name: "OpenAI", percentRemaining: 75 }],
        errors: [
          {
            kind: "intentional-filter",
            label: "OpenRouter",
            message: "Skipped (current model: gpt-5.6-sol)",
          },
          { label: "OpenAI", message: "Failed to parse quota response" },
        ],
      },
    });

    expect(line).toBe("OpenAI 75% | +1 issue");
  });

  it("renders the first error with a remaining count when no quota segments exist", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [],
        errors: [
          { label: "OpenAI", message: "Not configured" },
          { label: "Cursor", message: "Unavailable" },
        ],
      },
    });

    expect(line).toBe("OpenAI: Not configured +1");
  });

  it("omits the issue count when quota segments exist but the count does not fit", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: "Copilot 75%".length,
      data: {
        entries: [
          {
            name: "Copilot",
            percentRemaining: 75,
          },
        ],
        errors: [{ label: "OpenAI", message: "Not configured" }],
      },
    });

    expect(line).toBe("Copilot 75%");
  });

  it("renders structured quantities atomically with primary rows before supplementary rows", () => {
    const baseAccounting = {
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    } as const;
    const line = buildCompactQuotaStatusLine({
      accountingDetail: "detailed",
      maxWidth: 96,
      data: {
        entries: [
          {
            kind: "quantity",
            name: "gift",
            group: "MiMo",
            accounting: { ...baseAccounting, resultType: "balance" },
            semantic: {
              metric: { kind: "component", component: "gift_balance" },
              prominence: "supplementary",
            },
            quantity: { decimal: "8.25", unit: { kind: "currency", code: "CNY" } },
          },
          {
            kind: "quantity",
            name: "known-spend",
            group: "Cursor",
            accounting: { ...baseAccounting, resultType: "spend" },
            semantic: {
              metric: { kind: "named", name: "Known API" },
              prominence: "primary",
            },
            quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
          },
        ],
        errors: [],
      },
    });

    expect(line).toContain("Cursor: Known API spend USD 12.50");
    expect(line).toContain("MiMo: Gift balance CNY 8.25");
    expect(line.indexOf("Cursor")).toBeLessThan(line.indexOf("MiMo"));
  });

  it("keeps a structured financial value whole when compact width shortens its label", () => {
    const line = buildCompactQuotaStatusLine({
      maxWidth: 22,
      data: {
        entries: [
          {
            kind: "quantity",
            name: "balance",
            group: "A very long provider",
            accounting: {
              resultType: "balance",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
            },
            semantic: {
              metric: { kind: "component", component: "current_balance" },
              prominence: "primary",
            },
            quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
          },
        ],
        errors: [],
      },
    });

    expect(line.length).toBeLessThanOrEqual(22);
    expect(line).toContain("USD 12.50");
    expect(line).not.toContain("USD 1…");
  });

  it("admits detailed basis only as a complete compact fact", () => {
    const entry = {
      name: "monthly-budget",
      group: "Zen",
      accounting: {
        resultType: "budget",
        acquisitionMethod: "dashboard_scrape",
        ownership: "maintained",
        authority: "locally_derived",
      },
      semantic: {
        metric: { kind: "window", window: "month" },
        prominence: "primary",
      },
      percentRemaining: 94.25,
      basis: {
        remaining: {
          quantity: { decimal: "94.25", unit: { kind: "currency", code: "USD" } },
          authority: "locally_derived",
        },
      },
    } as const;
    const narrow = buildCompactQuotaStatusLine({
      accountingDetail: "detailed",
      maxWidth: 30,
      data: { entries: [entry], errors: [] },
    });
    const wide = buildCompactQuotaStatusLine({
      accountingDetail: "detailed",
      maxWidth: 80,
      data: { entries: [entry], errors: [] },
    });

    expect(narrow).not.toContain("Remaining:");
    expect(wide).toContain("(Remaining: USD 94.25)");
  });

  it("does not evaluate malformed basis for a suppressed non-finite semantic percent", () => {
    const line = buildCompactQuotaStatusLine({
      accountingDetail: "detailed",
      maxWidth: 80,
      data: {
        entries: [
          {
            name: "monthly-budget",
            group: "Zen",
            accounting: {
              resultType: "budget",
              acquisitionMethod: "dashboard_scrape",
              ownership: "maintained",
              authority: "locally_derived",
            },
            semantic: {
              metric: { kind: "window", window: "month" },
              prominence: "primary",
            },
            percentRemaining: Number.POSITIVE_INFINITY,
            basis: {
              remaining: {
                quantity: { decimal: "01", unit: { kind: "currency", code: "USD" } },
                authority: "locally_derived",
              },
            },
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("");
  });

  it("collapses whitespace, sanitizes control text, and truncates with ellipsis", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 18,
      data: {
        entries: [
          {
            name: "Open\u001b[31mAI\nProvider",
            percentRemaining: 42,
          },
        ],
        errors: [{ label: "Err\u0007", message: "Bad\u0003" }],
      },
    });

    expect(line).toBe("OpenAI Provider 4…");
    expect(line.length).toBeLessThanOrEqual(18);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\u0007");
    expect(line).not.toContain("\u0003");
  });
});
