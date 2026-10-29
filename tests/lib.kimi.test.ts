import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fetchMocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
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
  fetchWithTimeout: fetchMocks.fetchWithTimeout,
}));

import { queryKimiQuota } from "../src/lib/kimi.js";

function queryCn(apiKey = "cn-test-key", requestTimeoutMs?: number) {
  return queryKimiQuota({ apiKey, endpoint: "cn", requestTimeoutMs });
}

function mockKimiHttpSuccess(payload: unknown) {
  fetchMocks.fetchResponse.mockResolvedValueOnce({
    ok: true,
    json: async () => payload,
  });
}

function mockKimiHttpFailure(status: number, text: string) {
  fetchMocks.fetchResponse.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => text,
  });
}

const usagePayload = {
  usage: {
    limit: "100",
    used: "10",
    remaining: "90",
  },
};

describe("queryKimiQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds the Global key to the Global endpoint and forwards timeout", async () => {
    mockKimiHttpSuccess(usagePayload);

    const result = await queryKimiQuota({
      apiKey: "global-secret",
      endpoint: "global",
      requestTimeoutMs: 4321,
    });

    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.kimi.ai/coding/v1/usages",
      expect.objectContaining({
        request: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer global-secret" }),
        }),
        timeoutMs: 4321,
      }),
    );
    expect(result).toMatchObject({ success: true, label: "Kimi Code" });
  });

  it("binds the CN key to the CN endpoint", async () => {
    mockKimiHttpSuccess(usagePayload);

    const result = await queryCn("cn-secret");

    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.kimi.com/coding/v1/usages",
      expect.objectContaining({
        request: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer cn-secret" }),
        }),
      }),
    );
    expect(result).toMatchObject({ success: true, label: "Kimi Code (CN)" });
  });

  it("parses string numbers from the existing API shape", async () => {
    mockKimiHttpSuccess({
      usage: {
        limit: "100",
        used: "45",
        remaining: "55",
        resetTime: "2026-04-16T15:36:21.718434Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "100",
            used: "22",
            remaining: "78",
            resetTime: "2026-04-16T16:36:21.718434Z",
          },
        },
      ],
      parallel: { limit: "20" },
    });

    const result = await queryCn();

    expect(result).toMatchObject({
      success: true,
      label: "Kimi Code (CN)",
      windows: [
        {
          label: "Weekly limit",
          used: 45,
          limit: 100,
          percentRemaining: 55,
          resetTimeIso: "2026-04-16T15:36:21.718Z",
        },
        {
          label: "5h limit",
          used: 22,
          limit: 100,
          percentRemaining: 78,
          resetTimeIso: "2026-04-16T16:36:21.718Z",
        },
      ],
    });
  });

  it("computes used from remaining when used is absent", async () => {
    mockKimiHttpSuccess({ usage: { limit: "100", remaining: "30" } });

    await expect(queryCn()).resolves.toMatchObject({
      success: true,
      windows: [{ label: "Weekly limit", used: 70, limit: 100, percentRemaining: 30 }],
    });
  });

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden access"],
  ])("returns a sanitized HTTP %s error without trying the other host", async (status, body) => {
    mockKimiHttpFailure(status, body);

    await expect(queryCn()).resolves.toEqual({
      success: false,
      error: `Kimi API error ${status}: ${body}`,
    });
    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(fetchMocks.fetchWithTimeout.mock.calls[0]?.[0]).toBe(
      "https://api.kimi.com/coding/v1/usages",
    );
  });

  it("returns an error for an empty usable payload without trying the other host", async () => {
    mockKimiHttpSuccess({ message: "hello", code: 0 });

    await expect(queryCn()).resolves.toEqual({
      success: false,
      error: "Unexpected response structure (keys: message, code)",
    });
    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("sanitizes thrown errors without trying the other host", async () => {
    fetchMocks.fetchResponse.mockRejectedValue(new Error("network\u001b[31m error"));

    await expect(queryCn()).resolves.toEqual({
      success: false,
      error: "network error",
    });
    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit regional label", async () => {
    mockKimiHttpSuccess(usagePayload);

    await expect(
      queryKimiQuota({ apiKey: "key", endpoint: "global", label: "Custom Kimi" }),
    ).resolves.toMatchObject({ success: true, label: "Custom Kimi" });
  });
});
