import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    resolveOllamaCloudApiKey: vi.fn(),
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/ollama-cloud-config.js", () => ({
  resolveOllamaCloudApiKey: mocks.resolveOllamaCloudApiKey,
}));

import { _parseOllamaCloudBalance, queryOllamaCloudQuota } from "../src/lib/ollama-cloud.js";

function mockResponse(params: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
  jsonError?: Error;
}) {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: params.ok,
    status: params.status,
    text: async () => {
      if (params.jsonError) throw params.jsonError;
      return params.text ?? JSON.stringify(params.json);
    },
  });
}

// Credit-plan example from https://docs.ollama.com/api/balance.
const creditPlanPayload = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: {
      from: "2026-09-15T09:30:00Z",
      until: "2026-10-15T09:30:00Z",
    },
  },
  purchased: {
    balance_usd: 25,
  },
};

// Legacy-plan example from https://docs.ollama.com/api/balance.
const legacyPlanPayload = {
  included: {
    session: {
      remaining_percent: 75,
      resets_at: "2026-10-01T07:00:00Z",
    },
    weekly: {
      remaining_percent: 40,
      resets_at: "2026-10-05T00:00:00Z",
    },
  },
  purchased: {
    balance_usd: 25,
  },
};

describe("queryOllamaCloudQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOllamaCloudApiKey.mockResolvedValue({
      key: "ollama-secret-key",
      source: "env:OLLAMA_API_KEY",
    });
  });

  it("returns null without a configured API key", async () => {
    mocks.resolveOllamaCloudApiKey.mockResolvedValueOnce(null);

    await expect(queryOllamaCloudQuota()).resolves.toBeNull();
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("sends the exact balance request with a Bearer Authorization value", async () => {
    mockResponse({ ok: true, status: 200, json: creditPlanPayload });

    await queryOllamaCloudQuota();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://ollama.com/api/balance",
      expect.objectContaining({
        request: {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer ollama-secret-key",
          },
          redirect: "manual",
        },
        timeoutMs: undefined,
        consume: expect.any(Function),
      }),
    );
  });

  it("passes a configured request timeout", async () => {
    mockResponse({ ok: true, status: 200, json: creditPlanPayload });

    await queryOllamaCloudQuota({ requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeoutMs: 1234 }),
    );
  });

  it("maps included and purchased credits from a credit-plan response", async () => {
    mockResponse({ ok: true, status: 200, json: creditPlanPayload });

    const out = await queryOllamaCloudQuota();
    expect(out).toEqual({
      success: true,
      includedCredits: {
        balanceUsd: 72.5,
        allowanceUsd: 100,
        percentRemaining: 72.5,
        resetTimeIso: "2026-10-15T09:30:00.000Z",
      },
      purchasedUsd: 25,
    });
  });

  it("maps session and weekly limits from a legacy-plan response", async () => {
    mockResponse({ ok: true, status: 200, json: legacyPlanPayload });

    const out = await queryOllamaCloudQuota();
    expect(out).toEqual({
      success: true,
      session: { percentRemaining: 75, resetTimeIso: "2026-10-01T07:00:00.000Z" },
      weekly: { percentRemaining: 40, resetTimeIso: "2026-10-05T00:00:00.000Z" },
      purchasedUsd: 25,
    });
  });

  it("clamps included credits to 0..100% and has no share for a zero allowance", () => {
    expect(
      _parseOllamaCloudBalance({
        included: {
          balance_usd: 150,
          allowance_usd: 100,
          period: { until: "2026-10-15T09:30:00Z" },
        },
        purchased: { balance_usd: 0 },
      }),
    ).toMatchObject({ success: true, includedCredits: { percentRemaining: 100 } });
    expect(
      _parseOllamaCloudBalance({
        included: {
          balance_usd: -5,
          allowance_usd: 100,
          period: { until: "2026-10-15T09:30:00Z" },
        },
        purchased: { balance_usd: 0 },
      }),
    ).toMatchObject({ success: true, includedCredits: { percentRemaining: 0 } });
    expect(
      _parseOllamaCloudBalance({
        included: { balance_usd: 0, allowance_usd: 0, period: { until: "2026-10-15T09:30:00Z" } },
        purchased: { balance_usd: 25 },
      }),
    ).toEqual({
      success: true,
      includedCredits: {
        balanceUsd: 0,
        allowanceUsd: 0,
        resetTimeIso: "2026-10-15T09:30:00.000Z",
      },
      purchasedUsd: 25,
    });
  });

  it("keeps a limit without a reset time when resets_at is not a time", () => {
    expect(
      _parseOllamaCloudBalance({
        included: {
          session: { remaining_percent: 0, resets_at: "soon" },
          weekly: { remaining_percent: 100 },
        },
        purchased: { balance_usd: 0 },
      }),
    ).toEqual({
      success: true,
      session: { percentRemaining: 0 },
      weekly: { percentRemaining: 100 },
      purchasedUsd: 0,
    });
  });

  it("reports invalid independent fields and keeps the valid ones", () => {
    const out = _parseOllamaCloudBalance({
      included: {
        session: { remaining_percent: 20, resets_at: "2026-10-01T07:00:00Z" },
        weekly: { remaining_percent: 150, resets_at: "2026-10-05T00:00:00Z" },
      },
      purchased: { balance_usd: "25" },
    });

    expect(out).toEqual({
      success: true,
      session: { percentRemaining: 20, resetTimeIso: "2026-10-01T07:00:00.000Z" },
      rowErrors: [
        "Weekly: ignored invalid remaining percent",
        "Purchased credits: ignored invalid balance",
      ],
    });
  });

  it("reports invalid included credits and an unknown included shape", () => {
    expect(
      _parseOllamaCloudBalance({
        included: { balance_usd: 10, allowance_usd: -1 },
        purchased: { balance_usd: 25 },
      }),
    ).toEqual({
      success: true,
      purchasedUsd: 25,
      rowErrors: ["Included credits: ignored invalid balance"],
    });
    expect(
      _parseOllamaCloudBalance({ included: { monthly: {} }, purchased: { balance_usd: 25 } }),
    ).toEqual({
      success: true,
      purchasedUsd: 25,
      rowErrors: ["Included: expected credits or session and weekly limits"],
    });
    expect(_parseOllamaCloudBalance({ purchased: { balance_usd: 25 } })).toEqual({
      success: true,
      purchasedUsd: 25,
      rowErrors: ["Included: expected an object"],
    });
  });

  it.each([null, [], "invalid"])("rejects an invalid root payload: %j", (payload) => {
    expect(_parseOllamaCloudBalance(payload)).toEqual({
      success: false,
      error: "Ollama Cloud balance API returned an unexpected response shape",
    });
  });

  it.each([
    ["an empty object", {}],
    // The retired /api/usage limits shape.
    ["the old usage shape", { limits: { session: { usage: 0.25 }, weekly: { usage: 0.4 } } }],
    [
      "the new usage shape",
      { range: "7d", scope: "self", granularity: "day", totals: { request_count: 3 }, buckets: [] },
    ],
    [
      "only invalid fields",
      {
        included: { session: { remaining_percent: -1 }, weekly: { remaining_percent: Number.NaN } },
        purchased: { balance_usd: -2 },
      },
    ],
  ])("rejects a reply with no limits or balance: %s", (_name, payload) => {
    expect(_parseOllamaCloudBalance(payload)).toEqual({
      success: false,
      error: "Ollama Cloud balance API returned no limits or balance",
    });
  });

  it("reports non-success responses without leaking the API key", async () => {
    mockResponse({
      ok: false,
      status: 401,
      text: "Unauthorized\nollama-secret-key\u001b[31m",
    });

    const out = await queryOllamaCloudQuota();
    const error = out && !out.success ? out.error : "";

    expect(error).toBe("Ollama Cloud balance API error 401: Unauthorized [redacted]");
    expect(error).not.toContain("ollama-secret-key");
    expect(error).not.toContain("\u001b");
  });

  it("rejects an oversized response before parsing it", async () => {
    mockResponse({
      ok: true,
      status: 200,
      text: "x".repeat(256 * 1024 + 1),
    });

    const out = await queryOllamaCloudQuota();
    expect(out && !out.success ? out.error : "").toBe(
      "Ollama Cloud balance API response exceeded 262144 bytes",
    );
  });

  it("sanitizes malformed JSON and transport errors without leaking the API key", async () => {
    mockResponse({
      ok: true,
      status: 200,
      jsonError: new Error("bad JSON ollama-secret-key\nnext"),
    });

    const malformed = await queryOllamaCloudQuota();
    expect(malformed && !malformed.success ? malformed.error : "").toBe("bad JSON [redacted] next");

    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("timeout ollama-secret-key\u001b[31m"));
    const timedOut = await queryOllamaCloudQuota();
    expect(timedOut && !timedOut.success ? timedOut.error : "").toBe("timeout [redacted]");
  });
});
