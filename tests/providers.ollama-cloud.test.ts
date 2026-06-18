import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  queryOllamaCloudQuota: vi.fn(),
  resolveOllamaCloudConfigCached: vi.fn(),
}));

vi.mock("../src/lib/ollama-cloud-config.js", () => ({
  resolveOllamaCloudConfigCached: mocks.resolveOllamaCloudConfigCached,
  DEFAULT_OLLAMA_CLOUD_CONFIG_CACHE_MAX_AGE_MS: 30_000,
}));

vi.mock("../src/lib/ollama-cloud.js", () => ({
  queryOllamaCloudQuota: mocks.queryOllamaCloudQuota,
}));

import { ollamaCloudProvider } from "../src/providers/ollama-cloud.js";

function mockConfigNone() {
  mocks.resolveOllamaCloudConfigCached.mockResolvedValueOnce({ state: "none" });
}

function mockConfigIncomplete(source = "/tmp/ollama-cloud.json", missing = "cookie") {
  mocks.resolveOllamaCloudConfigCached.mockResolvedValueOnce({
    state: "incomplete",
    source,
    missing,
  });
}

function mockConfigInvalid(source = "/tmp/ollama-cloud.json", error = "broken config") {
  mocks.resolveOllamaCloudConfigCached.mockResolvedValueOnce({
    state: "invalid",
    source,
    error,
  });
}

function mockConfigConfigured(cookie = "session-cookie") {
  mocks.resolveOllamaCloudConfigCached.mockResolvedValueOnce({
    state: "configured",
    config: { cookie },
    source: "env",
  });
}

async function runProviderFetch(config: Record<string, unknown> = {}) {
  return ollamaCloudProvider.fetch({ config } as any);
}

describe("ollama-cloud provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when config is absent", async () => {
    mockConfigNone();

    const out = await runProviderFetch();

    expectNotAttempted(out);
    expect(mocks.queryOllamaCloudQuota).not.toHaveBeenCalled();
  });

  it("returns a config error when config is incomplete", async () => {
    mockConfigIncomplete();

    const out = await runProviderFetch();

    expectAttemptedWithErrorLabel(out, "Ollama Cloud");
    expect(out.errors[0]?.message).toContain("Missing cookie");
    expect(mocks.queryOllamaCloudQuota).not.toHaveBeenCalled();
  });

  it("returns a config error when config is invalid", async () => {
    mockConfigInvalid();

    const out = await runProviderFetch();

    expectAttemptedWithErrorLabel(out, "Ollama Cloud");
    expect(out.errors[0]?.message).toContain("Invalid config");
    expect(out.errors[0]?.message).toContain("/tmp/ollama-cloud.json");
    expect(mocks.queryOllamaCloudQuota).not.toHaveBeenCalled();
  });

  it("returns session and weekly entries on successful settings scrape", async () => {
    mockConfigConfigured();
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      session: {
        usagePercent: 25,
        percentRemaining: 75,
        resetTimeIso: "2026-06-14T10:00:00.000Z",
      },
      weekly: {
        usagePercent: 40,
        percentRemaining: 60,
        resetTimeIso: "2026-06-21T10:00:00.000Z",
      },
    });

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Ollama Cloud Session",
        group: "Ollama Cloud",
        label: "Session:",
        percentRemaining: 75,
        resetTimeIso: "2026-06-14T10:00:00.000Z",
      },
      {
        name: "Ollama Cloud Weekly",
        group: "Ollama Cloud",
        label: "Weekly:",
        percentRemaining: 60,
        resetTimeIso: "2026-06-21T10:00:00.000Z",
      },
    ]);
  });

  it("returns only a session entry when the scraper returns session usage", async () => {
    mockConfigConfigured();
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      session: {
        usagePercent: 25,
        percentRemaining: 75,
        resetTimeIso: "2026-06-14T10:00:00.000Z",
      },
    });

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Ollama Cloud Session",
        group: "Ollama Cloud",
        label: "Session:",
        percentRemaining: 75,
        resetTimeIso: "2026-06-14T10:00:00.000Z",
      },
    ]);
  });

  it("returns only a weekly entry when the scraper returns weekly usage", async () => {
    mockConfigConfigured();
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      weekly: {
        usagePercent: 40,
        percentRemaining: 60,
        resetTimeIso: "2026-06-21T10:00:00.000Z",
      },
    });

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Ollama Cloud Weekly",
        group: "Ollama Cloud",
        label: "Weekly:",
        percentRemaining: 60,
        resetTimeIso: "2026-06-21T10:00:00.000Z",
      },
    ]);
  });

  it("passes user-configured requestTimeoutMs to the scraper", async () => {
    mockConfigConfigured("cookie");
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      weekly: { usagePercent: 10, percentRemaining: 90 },
    });

    await runProviderFetch({ requestTimeoutMs: 1234, requestTimeoutMsConfigured: true });

    expect(mocks.queryOllamaCloudQuota).toHaveBeenCalledWith("cookie", {
      requestTimeoutMs: 1234,
    });
  });

  it("returns scraper errors with the provider label", async () => {
    mockConfigConfigured();
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: false,
      error: "Authentication error: redirected to /signin — cookie may be expired",
    });

    const out = await runProviderFetch();

    expectAttemptedWithErrorLabel(out, "Ollama Cloud");
    expect(out.errors[0]?.message).toContain("cookie may be expired");
  });

  it("returns an error when the scraper succeeds without usage entries", async () => {
    mockConfigConfigured();
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({ success: true });

    const out = await runProviderFetch();

    expectAttemptedWithErrorLabel(out, "Ollama Cloud");
    expect(out.errors[0]?.message).toBe("No usage data found on Ollama Cloud settings page");
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
    [{ state: "configured", config: { cookie: "ck" }, source: "env" }, true],
    [{ state: "incomplete", source: "/tmp/ollama-cloud.json", missing: "cookie" }, false],
    [{ state: "invalid", source: "/tmp/ollama-cloud.json", error: "broken" }, false],
    [{ state: "none" }, false],
  ])("returns correct availability for config state %j", async (configState, expected) => {
    mocks.resolveOllamaCloudConfigCached.mockResolvedValueOnce(configState);

    const available = await ollamaCloudProvider.isAvailable({} as any);

    expect(available).toBe(expected);
  });
});
