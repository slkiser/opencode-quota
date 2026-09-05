import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryZaiQuota } from "../src/lib/zai.js";
import { queryZhipuQuota } from "../src/lib/zhipu.js";

const mocks = vi.hoisted(() => ({
  resolveZaiAuthCached: vi.fn(),
  resolveZhipuAuthCached: vi.fn(),
}));

vi.mock("../src/lib/zai-auth.js", () => ({
  resolveZaiAuthCached: mocks.resolveZaiAuthCached,
}));
vi.mock("../src/lib/zhipu-auth.js", () => ({
  resolveZhipuAuthCached: mocks.resolveZhipuAuthCached,
}));

const providers = [
  {
    label: "Z.ai",
    endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
    httpErrorPrefix: "Z.ai API error",
    key: "zai-test-key",
    resolveAuth: mocks.resolveZaiAuthCached,
    query: queryZaiQuota,
  },
  {
    label: "Zhipu",
    endpoint: "https://bigmodel.cn/api/monitor/usage/quota/limit",
    httpErrorPrefix: "Zhipu API error",
    key: "zhipu-test-key",
    resolveAuth: mocks.resolveZhipuAuthCached,
    query: queryZhipuQuota,
  },
] as const;

type ProviderCase = (typeof providers)[number];

function configure(provider: ProviderCase): void {
  provider.resolveAuth.mockResolvedValueOnce({
    state: "configured",
    apiKey: provider.key,
    source: "opencode.db",
  });
}

function quotaResponse(limits: unknown): object {
  return { code: 0, msg: "ok", success: true, data: { level: "pro", limits } };
}

function stubJson(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock as any);
  return fetchMock;
}

beforeEach(() => {
  mocks.resolveZaiAuthCached.mockReset();
  mocks.resolveZhipuAuthCached.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GLM coding plan quota contract", () => {
  it("preserves unconfigured and invalid auth behavior", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const provider of providers) {
      provider.resolveAuth.mockResolvedValueOnce({ state: "none" });
      await expect(provider.query(), `${provider.label} missing auth`).resolves.toBeNull();

      const error = `Unsupported ${provider.label} auth type: "oauth"`;
      provider.resolveAuth.mockResolvedValueOnce({ state: "invalid", error });
      await expect(provider.query(), `${provider.label} invalid auth`).resolves.toEqual({
        success: false,
        error,
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses each explicit endpoint, auth resolver, header contract, and label", async () => {
    for (const provider of providers) {
      configure(provider);
      const fetchMock = stubJson(quotaResponse([]));

      await expect(provider.query(), provider.label).resolves.toEqual({
        success: true,
        label: provider.label,
        windows: {},
      });
      expect(provider.resolveAuth, `${provider.label} auth resolver`).toHaveBeenLastCalledWith();
      expect(fetchMock, `${provider.label} request`).toHaveBeenCalledWith(
        provider.endpoint,
        expect.objectContaining({
          headers: {
            Authorization: provider.key,
            "User-Agent": "OpenCode-Quota-Toast/1.0",
            "Content-Type": "application/json",
          },
          signal: expect.any(AbortSignal),
        }),
      );
    }
  });

  it("sanitizes and truncates HTTP error bodies with provider-specific prefixes", async () => {
    const unsafeBody = `\u001b[31m${"x".repeat(200)}`;

    for (const provider of providers) {
      configure(provider);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(unsafeBody, { status: 500 })) as any);

      await expect(provider.query(), provider.label).resolves.toEqual({
        success: false,
        error: `${provider.httpErrorPrefix} 500: ${"x".repeat(120)}`,
      });
    }
  });

  it("rejects missing or non-array limit envelopes", async () => {
    for (const provider of providers) {
      configure(provider);
      stubJson(quotaResponse(null));
      await expect(provider.query(), `${provider.label} null limits`).resolves.toEqual({
        success: false,
        error: "Invalid quota data",
      });

      configure(provider);
      stubJson(quotaResponse({}));
      await expect(provider.query(), `${provider.label} object limits`).resolves.toEqual({
        success: false,
        error: "Invalid quota data",
      });
    }
  });

  it("maps windows, ignores daily units in either order, clamps, and keeps later duplicates", async () => {
    const resetMs = 1_735_776_000_000;
    const limits = [
      { type: "TOKENS_LIMIT", unit: 4, percentage: 10, nextResetTime: resetMs },
      { type: "TOKENS_LIMIT", unit: 3, percentage: 120, nextResetTime: resetMs },
      { type: "TOKENS_LIMIT", unit: 6, percentage: 70, nextResetTime: resetMs },
      { type: "TOKENS_LIMIT", unit: 4, percentage: 90, nextResetTime: resetMs },
      { type: "TIME_LIMIT", unit: 9, percentage: 10, nextResetTime: -1 },
      { type: "TOKENS_LIMIT", unit: 3, percentage: -20, nextResetTime: resetMs + 0.4 },
    ];

    for (const provider of providers) {
      configure(provider);
      stubJson(quotaResponse(limits));

      await expect(provider.query(), provider.label).resolves.toEqual({
        success: true,
        label: provider.label,
        windows: {
          fiveHour: {
            percentRemaining: 100,
            resetTimeIso: new Date(resetMs).toISOString(),
          },
          weekly: {
            percentRemaining: 30,
            resetTimeIso: new Date(resetMs).toISOString(),
          },
          mcp: { percentRemaining: 90, resetTimeIso: undefined },
        },
      });
    }
  });

  it("sanitizes network failures and preserves timeout behavior", async () => {
    for (const provider of providers) {
      configure(provider);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error("\u001b[31mnetwork down"))) as any,
      );
      await expect(provider.query(), `${provider.label} network`).resolves.toEqual({
        success: false,
        error: "network down",
      });

      vi.useFakeTimers();
      configure(provider);
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})) as any);
      const result = provider.query({ requestTimeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result, `${provider.label} timeout`).resolves.toEqual({
        success: false,
        error: "Request timeout after 1s",
      });
      vi.useRealTimers();
    }
  });
});

describe("provider-specific GLM envelopes", () => {
  it("preserves Z.ai API-level errors and sanitized fallback labels", async () => {
    const cases = [
      {
        body: { code: 500, msg: "\u001b[31mcurrent user has no coding plan", success: false },
        error: "current user has no coding plan",
      },
      { body: { code: 401 }, error: "Z.ai API error 401" },
      { body: { success: false }, error: "Z.ai API error" },
    ];

    for (const testCase of cases) {
      configure(providers[0]);
      stubJson(testCase.body);
      await expect(queryZaiQuota()).resolves.toEqual({
        success: false,
        error: testCase.error,
      });
    }
  });

  it("maps Z.ai credit limits to percent windows without inferring credit amounts", async () => {
    const resetMs = 1_735_776_000_000;
    const creditLimits = [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 1,
        usage: 400,
        currentValue: 9_600,
        remaining: 9_600,
        percentage: 4,
        nextResetTime: resetMs,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 1_100,
        currentValue: 8_900,
        remaining: 8_900,
        percentage: 11,
        nextResetTime: resetMs + 1_000,
      },
    ];

    configure(providers[0]);
    stubJson(quotaResponse(creditLimits));
    const zaiResult = await queryZaiQuota();
    expect(zaiResult).toEqual({
      success: true,
      label: "Z.ai",
      windows: {
        fiveHour: {
          percentRemaining: 96,
          resetTimeIso: new Date(resetMs).toISOString(),
        },
        weekly: {
          percentRemaining: 89,
          resetTimeIso: new Date(resetMs + 1_000).toISOString(),
        },
      },
    });
    expect(zaiResult).not.toHaveProperty("windows.fiveHour.usage");
    expect(zaiResult).not.toHaveProperty("windows.fiveHour.currentValue");
    expect(zaiResult).not.toHaveProperty("windows.fiveHour.remaining");

    configure(providers[1]);
    stubJson(quotaResponse(creditLimits));
    await expect(queryZhipuQuota()).resolves.toEqual({
      success: true,
      label: "Zhipu",
      windows: {},
    });
  });

  it("allows Z.ai root limits but keeps Zhipu strict to data.limits", async () => {
    const rootEnvelope = {
      code: 0,
      msg: "ok",
      success: true,
      limits: [{ type: "TOKENS_LIMIT", unit: 6, percentage: 25 }],
    };

    configure(providers[0]);
    stubJson(rootEnvelope);
    await expect(queryZaiQuota()).resolves.toEqual({
      success: true,
      label: "Z.ai",
      windows: {
        weekly: { percentRemaining: 75, resetTimeIso: undefined },
      },
    });

    configure(providers[1]);
    stubJson(rootEnvelope);
    await expect(queryZhipuQuota()).resolves.toEqual({
      success: false,
      error: "Invalid quota data",
    });
  });
});
