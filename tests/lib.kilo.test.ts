import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    resolveKiloApiKey: vi.fn(),
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

vi.mock("../src/lib/kilo-config.js", () => ({
  resolveKiloApiKey: mocks.resolveKiloApiKey,
}));

import { queryKiloPassState, queryKiloQuota } from "../src/lib/kilo.js";

function mockResponse(params: { ok: boolean; status: number; json?: unknown; text?: string }) {
  const response = new Response(params.text ?? JSON.stringify(params.json), {
    status: params.status,
  });
  expect(response.ok).toBe(params.ok);
  mocks.fetchResponse.mockResolvedValueOnce(response);
}

function statePayload(overrides: Record<string, unknown> = {}) {
  return [
    {
      result: {
        data: {
          json: {
            subscription: {
              currentPeriodBaseCreditsUsd: 19,
              currentPeriodUsageUsd: 2.76,
              currentPeriodBonusCreditsUsd: 9.5,
              nextBillingAt: "2099-02-01T00:00:00.000Z",
              ...overrides,
            },
          },
        },
      },
    },
  ];
}

function noSubscriptionPayload() {
  return [{ result: { data: { json: { subscription: null } } } }];
}

describe("Kilo Gateway API client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveKiloApiKey.mockResolvedValue({
      key: "kilo-secret-key",
      source: "env:KILO_API_KEY",
    });
  });

  it("returns null without a configured API key", async () => {
    mocks.resolveKiloApiKey.mockResolvedValueOnce(null);

    await expect(queryKiloQuota()).resolves.toBeNull();
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("sends the batched tRPC state request with Bearer auth", async () => {
    mockResponse({ ok: true, status: 200, json: statePayload() });

    await queryKiloPassState({ requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://app.kilo.ai/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D",
      expect.objectContaining({
        request: {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer kilo-secret-key",
            "Content-Type": "application/json",
          },
          redirect: "manual",
        },
        timeoutMs: 1234,
        consume: expect.any(Function),
      }),
    );
  });

  it("parses the batched tRPC json envelope and derives remaining credits", async () => {
    mockResponse({ ok: true, status: 200, json: statePayload() });

    await expect(queryKiloPassState()).resolves.toEqual({
      success: true,
      baseCreditsUsd: 19,
      usageUsd: 2.76,
      bonusCreditsUsd: 9.5,
      remainingUsd: 25.74,
      overageUsd: 0,
      resetTimeIso: "2099-02-01T00:00:00.000Z",
    });
  });

  it("preserves the reset for an active pass with zero total credits", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: statePayload({
        currentPeriodBaseCreditsUsd: 0,
        currentPeriodUsageUsd: 0,
        currentPeriodBonusCreditsUsd: 0,
      }),
    });

    await expect(queryKiloPassState()).resolves.toEqual({
      success: true,
      baseCreditsUsd: 0,
      usageUsd: 0,
      bonusCreditsUsd: 0,
      remainingUsd: 0,
      overageUsd: 0,
      resetTimeIso: "2099-02-01T00:00:00.000Z",
    });
  });

  it("accepts the unwrapped envelope, defaults missing bonus to zero, and uses renewal", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        result: {
          data: {
            subscription: {
              currentPeriodBaseCreditsUsd: 5,
              currentPeriodUsageUsd: 1,
              nextRenewalAt: "2099-03-01T00:00:00.000Z",
            },
          },
        },
      },
    });

    await expect(queryKiloPassState()).resolves.toEqual({
      success: true,
      baseCreditsUsd: 5,
      usageUsd: 1,
      bonusCreditsUsd: 0,
      remainingUsd: 4,
      overageUsd: 0,
      resetTimeIso: "2099-03-01T00:00:00.000Z",
    });
  });

  it("clamps overage to zero and falls back to a valid renewal time", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: statePayload({
        currentPeriodBaseCreditsUsd: 10,
        currentPeriodUsageUsd: 12,
        currentPeriodBonusCreditsUsd: 0,
        nextBillingAt: "not-a-date",
        nextRenewalAt: "2099-03-01T00:00:00.000Z",
      }),
    });

    await expect(queryKiloPassState()).resolves.toEqual({
      success: true,
      baseCreditsUsd: 10,
      usageUsd: 12,
      bonusCreditsUsd: 0,
      remainingUsd: 0,
      overageUsd: 2,
      resetTimeIso: "2099-03-01T00:00:00.000Z",
    });
  });

  it("normalizes a parseable reset into the cache-safe ISO shape", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: statePayload({ nextBillingAt: "2099-02-01" }),
    });

    await expect(queryKiloPassState()).resolves.toMatchObject({
      success: true,
      resetTimeIso: "2099-02-01T00:00:00.000Z",
    });
  });

  it.each([
    ["currentPeriodBaseCreditsUsd", -1],
    ["currentPeriodUsageUsd", "2.76"],
    ["currentPeriodBonusCreditsUsd", -1],
  ])("rejects an invalid %s field", async (field, value) => {
    mockResponse({ ok: true, status: 200, json: statePayload({ [field]: value }) });

    await expect(queryKiloPassState()).resolves.toMatchObject({ success: false });
  });

  it("keeps direct Kilo Pass queries isolated from the balance fallback", async () => {
    mockResponse({ ok: true, status: 200, json: noSubscriptionPayload() });

    await expect(queryKiloPassState()).resolves.toEqual({
      success: false,
      error: "Kilo Gateway state API returned no active Kilo Pass subscription",
    });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("returns tagged Kilo Pass data without calling the balance endpoint", async () => {
    mockResponse({ ok: true, status: 200, json: statePayload() });

    await expect(queryKiloQuota()).resolves.toMatchObject({
      success: true,
      mode: "kilo_pass",
      remainingUsd: 25.74,
      overageUsd: 0,
    });
    expect(mocks.resolveKiloApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("falls back to the documented Gateway balance for a valid no-subscription response", async () => {
    mockResponse({ ok: true, status: 200, json: noSubscriptionPayload() });
    mockResponse({ ok: true, status: 200, json: { balance: 12.5 } });

    await expect(queryKiloQuota({ requestTimeoutMs: 2345 })).resolves.toEqual({
      success: true,
      mode: "gateway_balance",
      balanceUsd: 12.5,
    });
    expect(mocks.resolveKiloApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithTimeout).toHaveBeenNthCalledWith(
      2,
      "https://api.kilo.ai/api/profile/balance",
      expect.objectContaining({
        request: expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer kilo-secret-key" }),
        }),
        timeoutMs: 2345,
      }),
    );
  });

  it("also falls back when a valid state envelope omits subscription", async () => {
    mockResponse({ ok: true, status: 200, json: [{ result: { data: { json: {} } } }] });
    mockResponse({ ok: true, status: 200, json: { balance: 4.5 } });

    await expect(queryKiloQuota()).resolves.toEqual({
      success: true,
      mode: "gateway_balance",
      balanceUsd: 4.5,
    });
  });

  it("does not hide malformed state data or invalid credit fields with a balance fallback", async () => {
    mockResponse({ ok: true, status: 200, json: null });
    await expect(queryKiloQuota()).resolves.toMatchObject({ success: false });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.resolveKiloApiKey.mockResolvedValue({ key: "kilo-secret-key" });
    mockResponse({
      ok: true,
      status: 200,
      json: [{ result: { data: { json: "invalid" } } }],
    });
    await expect(queryKiloQuota()).resolves.toMatchObject({ success: false });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.resolveKiloApiKey.mockResolvedValue({ key: "kilo-secret-key" });
    mockResponse({
      ok: true,
      status: 200,
      json: statePayload({ currentPeriodBaseCreditsUsd: -1 }),
    });
    await expect(queryKiloQuota()).resolves.toMatchObject({ success: false });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not fall back after a Kilo Pass HTTP failure", async () => {
    mockResponse({ ok: false, status: 401, text: "Unauthorized\nkilo-secret-key\u001b[31m" });

    const out = await queryKiloQuota();
    const error = out && !out.success ? out.error : "";

    expect(error).toBe("Kilo Gateway state API error 401: Unauthorized [redacted]");
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("reports a sanitized balance fallback failure", async () => {
    mockResponse({ ok: true, status: 200, json: noSubscriptionPayload() });
    mockResponse({
      ok: false,
      status: 503,
      text: "down\nkilo-secret-key\u001b[31m",
    });

    const out = await queryKiloQuota();
    const error = out && !out.success ? out.error : "";

    expect(error).toBe(
      "Kilo Gateway has no active Kilo Pass subscription; balance fallback failed: Kilo Gateway balance API error 503: down [redacted]",
    );
    expect(error).not.toContain("kilo-secret-key");
    expect(error).not.toContain("\u001b");
  });

  it("rejects an invalid balance without inventing quota data", async () => {
    mockResponse({ ok: true, status: 200, json: noSubscriptionPayload() });
    mockResponse({ ok: true, status: 200, json: { balance: -1 } });

    await expect(queryKiloQuota()).resolves.toEqual({
      success: false,
      error:
        "Kilo Gateway has no active Kilo Pass subscription; balance fallback failed: Kilo Gateway balance API returned an invalid balance",
    });
  });

  it("stops reading oversized responses before parsing", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(32 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
        throw new Error("cancel failed");
      },
    });
    mocks.fetchResponse.mockResolvedValueOnce({ ok: true, status: 200, body });

    const out = await queryKiloPassState();
    expect(out && !out.success ? out.error : "").toBe(
      "Kilo Gateway state API response exceeded 65536 bytes",
    );
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("sanitizes parse and transport errors without leaking the key", async () => {
    mockResponse({ ok: true, status: 200, text: "not json kilo-secret-key\nnext" });

    const malformed = await queryKiloPassState();
    expect(malformed && !malformed.success ? malformed.error : "").toContain("Unexpected token");
    expect(JSON.stringify(malformed)).not.toContain("kilo-secret-key");

    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("timeout kilo-secret-key\nnext"));
    const timedOut = await queryKiloPassState();
    expect(timedOut && !timedOut.success ? timedOut.error : "").toBe("timeout [redacted] next");
  });
});
