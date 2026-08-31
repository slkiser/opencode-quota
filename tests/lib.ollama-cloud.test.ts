import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { _parseOllamaCloudUsage, queryOllamaCloudQuota } from "../src/lib/ollama-cloud.js";

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

const usagePayload = {
  limits: {
    session: {
      usage: 0.25,
      models: [{ name: "glm-5.3-flash", request_count: 57 }],
    },
    weekly: {
      usage: 0.405,
      models: [{ name: "glm-5.3-flash", request_count: 162 }],
    },
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

  it("sends the exact usage request with the raw Authorization value", async () => {
    mockResponse({ ok: true, status: 200, json: usagePayload });

    await queryOllamaCloudQuota();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://ollama.com/api/usage",
      expect.objectContaining({
        request: {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "ollama-secret-key",
          },
          redirect: "manual",
        },
        timeoutMs: undefined,
        consume: expect.any(Function),
      }),
    );
    const request = mocks.fetchWithTimeout.mock.calls[0]?.[1]?.request;
    expect(request.headers.Authorization).not.toContain("Bearer ");
  });

  it("passes a configured request timeout", async () => {
    mockResponse({ ok: true, status: 200, json: usagePayload });

    await queryOllamaCloudQuota({ requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeoutMs: 1234 }),
    );
  });

  it("maps usage fractions from a real nested Ollama response", async () => {
    mockResponse({ ok: true, status: 200, json: usagePayload });

    const out = await queryOllamaCloudQuota();
    expect(out).toEqual({
      success: true,
      session: {
        usageFraction: 0.25,
        usagePercent: 25,
        percentRemaining: 75,
      },
      weekly: {
        usageFraction: 0.405,
        usagePercent: 40.5,
        percentRemaining: 59.5,
      },
    });
    expect(out?.success ? out.rowErrors : undefined).toBeUndefined();
  });

  it("preserves zero and fully-used fraction boundaries", () => {
    expect(
      _parseOllamaCloudUsage({
        limits: {
          session: { usage: 0 },
          weekly: { usage: 1 },
        },
      }),
    ).toEqual({
      success: true,
      session: { usageFraction: 0, usagePercent: 0, percentRemaining: 100 },
      weekly: { usageFraction: 1, usagePercent: 100, percentRemaining: 0 },
    });
  });

  it("reports invalid independent usage windows", () => {
    const out = _parseOllamaCloudUsage({
      limits: {
        session: { usage: 0.2 },
        weekly: { usage: 1.5 },
      },
    });

    expect(out).toMatchObject({
      success: true,
      session: { usageFraction: 0.2, usagePercent: 20, percentRemaining: 80 },
    });
    expect(out?.success ? out.rowErrors : []).toEqual(["Weekly: ignored invalid usage fraction"]);
  });

  it.each([null, [], "invalid"])("rejects an invalid root payload: %j", (payload) => {
    expect(_parseOllamaCloudUsage(payload)).toEqual({
      success: false,
      error: "Ollama Cloud usage API returned an unexpected response shape",
    });
  });

  it("rejects an object with no usable usage data", () => {
    expect(
      _parseOllamaCloudUsage({
        limits: { session: { usage: -1 }, weekly: { usage: Number.NaN } },
      }),
    ).toEqual({
      success: false,
      error: "Ollama Cloud usage API returned no usable usage data",
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

    expect(error).toBe("Ollama Cloud usage API error 401: Unauthorized [redacted]");
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
      "Ollama Cloud usage API response exceeded 262144 bytes",
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
