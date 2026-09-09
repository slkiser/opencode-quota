import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  agyQuery: vi.fn(),
  geminiQuery: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: mocks.rows,
}));
vi.mock("../src/lib/google-agy.js", () => ({
  hasAgyQuotaRuntimeAvailable: vi.fn(),
  inspectAgyAuthPresence: vi.fn(async () => ({
    state: "configured",
    sourceKey: "google-agy",
    accountCount: 2,
    validAccountCount: 2,
  })),
  queryGoogleAgyQuota: mocks.agyQuery,
}));
vi.mock("../src/lib/google-gemini-cli.js", () => ({
  hasGeminiCliQuotaRuntimeAvailable: vi.fn(),
  inspectGeminiCliAuthPresence: vi.fn(async () => ({
    state: "configured",
    sourceKey: "google-gemini-cli",
    accountCount: 2,
    validAccountCount: 2,
  })),
  queryGeminiCliQuota: mocks.geminiQuery,
}));
vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: vi.fn(async () => ({ state: "present", resolvedPath: "/plugin" })),
}));
vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  inspectGeminiCliCompanionPresence: vi.fn(async () => ({
    state: "present",
    resolvedPath: "/plugin",
  })),
}));

import { googleAgyProvider } from "../src/providers/google-agy.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";

describe.each([
  {
    name: "Google AGY",
    integrationId: "google-agy",
    provider: googleAgyProvider,
    query: mocks.agyQuery,
    result: {
      success: true,
      buckets: [
        {
          family: "Gemini Models",
          window: "weekly",
          windowLabel: "Weekly",
          accountIndex: 0,
          percentRemaining: 70,
        },
      ],
    },
  },
  {
    name: "Gemini CLI",
    integrationId: "google-gemini-cli",
    provider: googleGeminiCliProvider,
    query: mocks.geminiQuery,
    result: {
      success: true,
      buckets: [{ displayName: "Gemini 2.5", percentRemaining: 70 }],
    },
  },
])("$name DB credentials", ({ integrationId, provider, query, result }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.mockResolvedValue([
      {
        id: "active-id",
        integrationId,
        label: "Work",
        active: true,
        value: { type: "oauth", refresh: "one|project" },
      },
      {
        id: "other-id",
        integrationId,
        label: "Work",
        active: false,
        value: { type: "oauth", refresh: "two|project" },
      },
    ]);
    query.mockResolvedValue(result);
  });

  it("queries every row without deduping duplicate aliases", async () => {
    const output = await provider.fetch({ client: {}, config: {} } as never);

    expect(query).toHaveBeenCalledTimes(2);
    expect(output.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      [`[${provider.id === "google-agy" ? "Google AGY" : "Gemini CLI"} Work]*`, "active-id"],
      [`[${provider.id === "google-agy" ? "Google AGY" : "Gemini CLI"} Work 2]`, "other-id"],
    ]);
  });
});
