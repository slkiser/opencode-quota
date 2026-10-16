import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

vi.mock("../src/lib/cursor-detection.js", () => ({
  CURSOR_CANONICAL_PLUGIN_PACKAGE: "cursor-opencode-provider",
  inspectCursorAuthPresence: vi.fn(async () => ({
    state: "missing",
    presentPaths: [],
    candidatePaths: [],
  })),
  inspectCursorOpenCodeIntegration: vi.fn(async () => ({
    pluginEnabled: false,
    providerConfigured: false,
    matchedPaths: [],
    checkedPaths: [],
  })),
}));

vi.mock("../src/lib/cursor-usage.js", () => ({
  getCurrentCursorUsageSummary: vi.fn(),
}));

import { rowsFromProviderResult } from "../src/core/rows.js";
import { inspectCursorOpenCodeIntegration } from "../src/lib/cursor-detection.js";
import { getCurrentCursorUsageSummary } from "../src/lib/cursor-usage.js";
import { isCanonicalProviderAvailable } from "../src/lib/provider-availability.js";
import type { ProviderFetchResult } from "../src/providers/contract.js";
import { cursorProvider } from "../src/providers/cursor.js";
import { rowSummary } from "./helpers/provider-fetch.js";

const RESET = "2026-03-01T00:00:00.000Z";
const CYCLE_START = "2026-02-01T00:00:00.000Z";
const OBSERVED_AT = "2026-02-15T12:00:00.000Z";

function usageSummary(params: {
  apiCost: number;
  apiMessages?: number;
  autoCost?: number;
  autoMessages?: number;
  unknownModels?: number;
  source?: "configured_day" | "calendar_month";
}) {
  const apiMessages = params.apiMessages ?? 1;
  const autoCost = params.autoCost ?? 0;
  const autoMessages = params.autoMessages ?? 0;
  return {
    window: {
      source: params.source ?? "calendar_month",
      sinceMs: Date.parse(CYCLE_START),
      untilMs: Date.parse(RESET),
      resetTimeIso: RESET,
    },
    observedAtMs: Date.parse(OBSERVED_AT),
    api: { costUsd: params.apiCost, tokens: {}, messageCount: apiMessages },
    autoComposer: { costUsd: autoCost, tokens: {}, messageCount: autoMessages },
    total: {
      costUsd: params.apiCost + autoCost,
      tokens: {},
      messageCount: apiMessages + autoMessages,
    },
    unknownModels: Array.from({ length: params.unknownModels ?? 0 }, () => ({
      sourceModelID: "cursor/future-model",
      messageCount: 1,
      tokens: {},
    })),
  };
}

async function fetchCursor(config: Record<string, unknown>, summary: unknown) {
  vi.mocked(getCurrentCursorUsageSummary).mockResolvedValueOnce(summary as never);
  return (await cursorProvider.fetch({ config } as never)) as ProviderFetchResult;
}

describe("cursor provider", () => {
  it.each([
    [
      "nothing without usage or an included budget",
      { cursorPlan: "none" },
      usageSummary({ apiCost: 0, apiMessages: 0 }),
      [],
      { code: "not_configured" },
    ],
    [
      "the plan's API budget and Auto+Composer spend",
      { cursorPlan: "pro" },
      usageSummary({ apiCost: 5, autoCost: 1.25, autoMessages: 1 }),
      [
        ["cursor.api", "Pro", "API", "month", "75 (5 USD of 20 USD)", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "1.25 USD", RESET],
      ],
      undefined,
    ],
    [
      "an overspent configured budget below zero",
      { cursorPlan: "pro", cursorIncludedApiUsd: 10 },
      usageSummary({ apiCost: 12 }),
      [
        ["cursor.api", "Pro", "API", "month", "-20 (12 USD of 10 USD)", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "0 USD", RESET],
      ],
      undefined,
    ],
    [
      "spend without a plan",
      { cursorPlan: "none" },
      usageSummary({ apiCost: 0.5, autoCost: 1.25, autoMessages: 1 }),
      [
        ["cursor.api", null, "API", "month", "0.5 USD", RESET],
        ["cursor.auto_composer", null, "Auto+Composer", "month", "1.25 USD", RESET],
      ],
      undefined,
    ],
    [
      "spend for a zero allowance",
      { cursorPlan: "pro", cursorIncludedApiUsd: 0 },
      usageSummary({ apiCost: 0 }),
      [
        ["cursor.api", "Pro", "API", "month", "0 USD", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "0 USD", RESET],
      ],
      undefined,
    ],
    [
      "only known API spend, and an error, when some models are unknown",
      { cursorPlan: "pro" },
      usageSummary({ apiCost: 2, unknownModels: 1 }),
      [
        ["cursor.api", "Pro", "Known API", "month", "2 USD", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "0 USD", RESET],
      ],
      { detail: "Unknown Cursor model ids present in local history (see /quota_status)" },
    ],
  ])("shows %s", async (_name, config, summary, rows, error) => {
    const fetched = rowsFromProviderResult("cursor", await fetchCursor(config, summary));

    expect(rowSummary(fetched.rows)).toEqual(rows);
    if (error) expect(fetched.error).toMatchObject(error);
    else expect(fetched.error).toBeUndefined();
  });

  it.each([
    ["a configured start day", "configured_day", CYCLE_START],
    ["the calendar month", "calendar_month", undefined],
  ] as const)("dates the cycle from %s only when it is fixed", async (_name, source, startedAt) => {
    const result = await fetchCursor(
      { cursorPlan: "pro", cursorBillingCycleStartDay: 1 },
      usageSummary({ apiCost: 5, source }),
    );

    expect(rowsFromProviderResult("cursor", result).rows[0]?.windowStartedAt).toBe(startedAt);
  });

  it.each([
    ["provider metadata", true, { currentModel: "openai/gpt-5" }, {}, true],
    [
      "the current provider id",
      false,
      { currentModel: "auto", currentProviderID: "cursor" },
      {},
      true,
    ],
    ["a Cursor model", false, { currentModel: "cursor-acp/auto" }, {}, true],
    [
      "the plugin in a config file",
      false,
      { currentModel: "openai/gpt-5" },
      { pluginEnabled: true },
      true,
    ],
    [
      "a provider in a config file",
      false,
      { currentModel: "openai/gpt-5" },
      { providerConfigured: true },
      true,
    ],
    ["no signal", false, { currentModel: "openai/gpt-5" }, {}, false],
  ])("isAvailable via %s -> %s", async (_label, viaMetadata, config, integration, expected) => {
    vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(viaMetadata);
    vi.mocked(inspectCursorOpenCodeIntegration).mockResolvedValue({
      pluginEnabled: false,
      providerConfigured: false,
      matchedPaths: [],
      checkedPaths: ["/tmp/opencode.json"],
      ...integration,
    });

    await expect(
      cursorProvider.isAvailable({
        client: { config: { providers: vi.fn() } },
        config: { ...config, cursorPlan: "none" },
      } as never),
    ).resolves.toBe(expected);
  });
});
