import { beforeEach, describe, expect, it, vi } from "vitest";

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

function queryChina(apiKey = "test-key") {
  return queryKimiQuota({ apiKey, endpoint: "china" });
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

describe("queryKimiQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses string numbers from real API shape", async () => {
    mockKimiHttpSuccess({
      usage: {
        limit: "100",
        used: "45",
        remaining: "55",
        resetTime: "2026-04-16T15:36:21.718434Z",
      },
      limits: [
        {
          window: {
            duration: 300,
            timeUnit: "TIME_UNIT_MINUTE",
          },
          detail: {
            limit: "100",
            used: "22",
            remaining: "78",
            resetTime: "2026-04-16T16:36:21.718434Z",
          },
        },
      ],
      parallel: {
        limit: "20",
      },
    });

    const result = await queryChina();

    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.kimi.com/coding/v1/usages",
      expect.any(Object),
    );
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

  it("queries the global usage endpoint", async () => {
    mockKimiHttpSuccess({
      usage: {
        limit: "100",
        used: "10",
        remaining: "90",
      },
    });

    const result = await queryKimiQuota({ apiKey: "global-key", endpoint: "global" });

    expect(fetchMocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.kimi.ai/coding/v1/usages",
      expect.any(Object),
    );
    expect(result).toMatchObject({
      success: true,
      label: "Kimi Code",
      windows: [
        {
          label: "Weekly limit",
          used: 10,
          limit: 100,
          percentRemaining: 90,
        },
      ],
    });
  });

  it("computes used from remaining when used is absent", async () => {
    mockKimiHttpSuccess({
      usage: {
        limit: "100",
        remaining: "30",
      },
    });

    const result = await queryChina();

    expect(result).toMatchObject({
      success: true,
      windows: [
        {
          label: "Weekly limit",
          used: 70,
          limit: 100,
          percentRemaining: 30,
        },
      ],
    });
  });

  it("returns error when endpoint fails", async () => {
    mockKimiHttpFailure(401, "Unauthorized");

    const result = await queryChina();

    expect(result).toEqual({
      success: false,
      error: "Kimi API error 401: Unauthorized",
    });
  });

  it("returns error with unexpected response keys when endpoint has no usable data", async () => {
    mockKimiHttpSuccess({ message: "hello", code: 0 });

    const result = await queryChina();

    expect(result).toMatchObject({
      success: false,
      error: "Unexpected response structure (keys: message, code)",
    });
  });

  it("returns API error on non-200 with sanitized text", async () => {
    mockKimiHttpFailure(403, "Forbidden access");

    const result = await queryChina();

    expect(result).toMatchObject({
      success: false,
      error: "Kimi API error 403: Forbidden access",
    });
  });

  it("sanitizes thrown errors", async () => {
    fetchMocks.fetchResponse.mockRejectedValue(new Error("network error"));

    const result = await queryChina();

    expect(result).toEqual({
      success: false,
      error: "network error",
    });
  });
});
