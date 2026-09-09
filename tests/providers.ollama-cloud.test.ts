import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  getOllamaCloudKeyDiagnostics: vi.fn(),
  hasOllamaCloudApiKey: vi.fn(),
  queryOllamaCloudQuota: vi.fn(),
}));

vi.mock("../src/lib/ollama-cloud-config.js", () => ({
  getOllamaCloudKeyDiagnostics: mocks.getOllamaCloudKeyDiagnostics,
  hasOllamaCloudApiKey: mocks.hasOllamaCloudApiKey,
}));

vi.mock("../src/lib/ollama-cloud.js", () => ({
  queryOllamaCloudQuota: mocks.queryOllamaCloudQuota,
}));

import { ollamaCloudProvider } from "../src/providers/ollama-cloud.js";

async function runProviderFetch(config: Record<string, unknown> = {}) {
  return ollamaCloudProvider.fetch({ config } as any);
}

describe("ollama-cloud provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOllamaCloudKeyDiagnostics.mockResolvedValue({
      configured: true,
      source: "env:OLLAMA_API_KEY",
      checkedPaths: ["env:OLLAMA_API_KEY"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
  });

  it("returns attempted:false when no API key is configured", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce(null);

    const out = await runProviderFetch();

    expectNotAttempted(out);
    expect(out.statusDetails).toContainEqual({ key: "api_key_configured", value: "true" });
  });

  it("maps session, weekly, and sorted model request entries", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      session: {
        usageFraction: 0.25,
        usagePercent: 25,
        percentRemaining: 75,
      },
      weekly: {
        usageFraction: 0.4,
        usagePercent: 40,
        percentRemaining: 60,
      },
      models: [
        { model: "deepseek-v3.1:671b", requests: 1 },
        { model: "qwen3-coder:480b", requests: 12 },
      ],
    });

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "ollama-cloud")).toEqual([
      {
        name: "Ollama Cloud Session",
        group: "Ollama Cloud",
        label: "Session:",
        percentRemaining: 75,
      },
      {
        name: "Ollama Cloud Weekly",
        group: "Ollama Cloud",
        label: "Weekly:",
        percentRemaining: 60,
      },
      {
        kind: "value",
        name: "Ollama Cloud deepseek-v3.1:671b",
        group: "Ollama Cloud",
        label: "deepseek-v3.1:671b:",
        metricLabel: "deepseek-v3.1:671b",
        value: "1 request",
      },
      {
        kind: "value",
        name: "Ollama Cloud qwen3-coder:480b",
        group: "Ollama Cloud",
        label: "qwen3-coder:480b:",
        metricLabel: "qwen3-coder:480b",
        value: "12 requests",
      },
    ]);
    expect(out.entries.map((entry) => entry.accounting)).toEqual([
      {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      {
        resultType: "usage",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      {
        resultType: "usage",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "api_key_source", value: "env:OLLAMA_API_KEY" },
        { key: "session_usage_fraction", value: "0.25" },
        { key: "weekly_usage_fraction", value: "0.4" },
        { key: "model_rows", value: "2" },
      ]),
    );
  });

  it("keeps valid entries and exposes row-level response errors", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      session: {
        usageFraction: 0.25,
        usagePercent: 25,
        percentRemaining: 75,
      },
      models: [],
      rowErrors: ["Weekly: ignored invalid usage fraction"],
    });

    const out = await runProviderFetch();

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.errors[0]?.label).toBe("Ollama Cloud");
    expect(out.errors[0]?.message).toBe("Weekly: ignored invalid usage fraction");
    expect(out.statusDetails).toContainEqual({
      key: "live_error_1",
      value: "Weekly: ignored invalid usage fraction",
    });
  });

  it("passes the effective request timeout", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValue({
      success: true,
      weekly: { usageFraction: 0.1, usagePercent: 10, percentRemaining: 90 },
      models: [],
    });

    await runProviderFetch({ requestTimeoutMs: 1234, requestTimeoutMsConfigured: true });
    expect(mocks.queryOllamaCloudQuota).toHaveBeenLastCalledWith({ requestTimeoutMs: 1234 });

    await runProviderFetch({ requestTimeoutMs: 5678, requestTimeoutMsConfigured: false });
    expect(mocks.queryOllamaCloudQuota).toHaveBeenLastCalledWith({ requestTimeoutMs: 5678 });
  });

  it("returns API errors with the provider label", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: false,
      error: "Ollama Cloud usage API error 401: invalid credentials",
    });

    const out = await runProviderFetch();

    expectAttemptedWithErrorLabel(out, "Ollama Cloud");
    expect(out.errors[0]?.message).toContain("invalid credentials");
  });
});

describe("ollama-cloud matchesCurrentModel", () => {
  it.each([
    ["ollama-cloud/gpt-oss:20b-cloud", true],
    ["OLLAMA-CLOUD/gpt-oss:120b-cloud", true],
    ["ollama/gpt-oss", false],
    ["openai/gpt-4", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(ollamaCloudProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});

describe("ollama-cloud isAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [true, true],
    [false, false],
  ])("returns %s when API key availability is %s", async (configured, expected) => {
    mocks.hasOllamaCloudApiKey.mockResolvedValueOnce(configured);

    await expect(ollamaCloudProvider.isAvailable({} as any)).resolves.toBe(expected);
  });
});
