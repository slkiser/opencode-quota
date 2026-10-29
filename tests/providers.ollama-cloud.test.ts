import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
      authPaths: ["/tmp/auth.json"],
    });
  });

  it("returns attempted:false when no API key is configured", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce(null);

    const out = await runProviderFetch();

    expectNotAttempted(out);
    expect(out.statusDetails).toContainEqual({ key: "api_key_configured", value: "true" });
  });

  it("maps legacy session and weekly limits with reset times", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      session: { percentRemaining: 75, resetTimeIso: "2026-10-01T07:00:00.000Z" },
      weekly: { percentRemaining: 40, resetTimeIso: "2026-10-05T00:00:00.000Z" },
      purchasedUsd: 0,
    });

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "ollama-cloud")).toEqual([
      {
        name: "Ollama Cloud Session",
        group: "Ollama Cloud",
        label: "Session:",
        percentRemaining: 75,
        resetTimeIso: "2026-10-01T07:00:00.000Z",
      },
      {
        name: "Ollama Cloud Weekly",
        group: "Ollama Cloud",
        label: "Weekly:",
        percentRemaining: 40,
        resetTimeIso: "2026-10-05T00:00:00.000Z",
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
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "api_key_source", value: "env:OLLAMA_API_KEY" },
        { key: "session_remaining_percent", value: "75" },
        { key: "session_resets_at", value: "2026-10-01T07:00:00.000Z" },
        { key: "weekly_remaining_percent", value: "40" },
        { key: "weekly_resets_at", value: "2026-10-05T00:00:00.000Z" },
        { key: "purchased_balance_usd", value: "0" },
      ]),
    );
  });

  it("maps included credits to a Monthly row and purchased credits to a value row", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      includedCredits: {
        balanceUsd: 72.5,
        allowanceUsd: 100,
        percentRemaining: 72.5,
        resetTimeIso: "2026-10-15T09:30:00.000Z",
      },
      purchasedUsd: 25,
    });

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "ollama-cloud")).toEqual([
      {
        name: "Ollama Cloud Monthly",
        group: "Ollama Cloud",
        label: "Monthly:",
        percentRemaining: 72.5,
        resetTimeIso: "2026-10-15T09:30:00.000Z",
      },
      {
        kind: "value",
        name: "Ollama Cloud Purchased",
        group: "Ollama Cloud",
        label: "Purchased:",
        value: "$25.00 left",
      },
    ]);
    expect(out.entries[1]?.accounting).toEqual({
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    });
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "included_balance_usd", value: "72.5" },
        { key: "included_allowance_usd", value: "100" },
        { key: "included_period_until", value: "2026-10-15T09:30:00.000Z" },
        { key: "purchased_balance_usd", value: "25" },
      ]),
    );
    expect(out.statusDetails?.map((detail) => detail.key)).not.toContain(
      "session_remaining_percent",
    );
  });

  it("hides a zero purchased balance next to other rows but shows it when it is the only data", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      includedCredits: { balanceUsd: 10, allowanceUsd: 20, percentRemaining: 50 },
      purchasedUsd: 0,
    });
    const withIncluded = await runProviderFetch();
    expect(withIncluded.entries.map((entry) => entry.name)).toEqual(["Ollama Cloud Monthly"]);

    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      includedCredits: { balanceUsd: 0, allowanceUsd: 0 },
      purchasedUsd: 0,
    });
    const purchasedOnly = await runProviderFetch();
    expectAttemptedWithNoErrors(purchasedOnly);
    expect(visibleEntries(purchasedOnly.entries, "ollama-cloud")).toEqual([
      {
        kind: "value",
        name: "Ollama Cloud Purchased",
        group: "Ollama Cloud",
        label: "Purchased:",
        value: "$0.00 left",
      },
    ]);
  });

  it("reports no limits or balance when no row can be shown", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      includedCredits: { balanceUsd: 0, allowanceUsd: 0 },
    });

    const out = await runProviderFetch();

    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      { label: "Ollama Cloud", message: "Ollama Cloud returned no limits or balance" },
    ]);
  });

  it("keeps valid entries and exposes row-level response errors", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      session: { percentRemaining: 75 },
      rowErrors: ["Weekly: ignored invalid remaining percent"],
    });

    const out = await runProviderFetch();

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).not.toHaveProperty("resetTimeIso");
    expect(out.errors[0]?.label).toBe("Ollama Cloud");
    expect(out.errors[0]?.message).toBe("Weekly: ignored invalid remaining percent");
    expect(out.statusDetails).toContainEqual({
      key: "live_error_1",
      value: "Weekly: ignored invalid remaining percent",
    });
  });

  it("passes the effective request timeout", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValue({
      success: true,
      weekly: { percentRemaining: 90 },
    });

    await runProviderFetch({ requestTimeoutMs: 1234, requestTimeoutMsConfigured: true });
    expect(mocks.queryOllamaCloudQuota).toHaveBeenLastCalledWith({ requestTimeoutMs: 1234 });

    await runProviderFetch({ requestTimeoutMs: 5678, requestTimeoutMsConfigured: false });
    expect(mocks.queryOllamaCloudQuota).toHaveBeenLastCalledWith({ requestTimeoutMs: 5678 });
  });

  it("returns API errors with the provider label", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: false,
      error: "Ollama Cloud balance API error 401: invalid credentials",
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
