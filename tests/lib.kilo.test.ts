import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { _parseKiloBalance, queryKiloBalance } from "../src/lib/kilo.js";

function mockResponse(params: { ok: boolean; status: number; json?: unknown; text?: string }) {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: params.ok,
    status: params.status,
    text: async () => params.text ?? JSON.stringify(params.json),
  });
}

describe("queryKiloBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveKiloApiKey.mockResolvedValue({
      key: "kilo-secret-key",
      source: "env:KILO_API_KEY",
    });
  });

  it("returns null without a configured API key", async () => {
    mocks.resolveKiloApiKey.mockResolvedValueOnce(null);

    await expect(queryKiloBalance()).resolves.toBeNull();
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("sends the documented profile balance request with Bearer auth", async () => {
    mockResponse({ ok: true, status: 200, json: { balance: 12.34 } });

    await queryKiloBalance({ requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.kilo.ai/api/profile/balance",
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

  it.each([0, 12.345])("accepts a documented numeric USD balance: %s", (balance) => {
    expect(_parseKiloBalance({ balance })).toEqual({ success: true, balanceUsd: balance });
  });

  it.each([
    null,
    [],
    { balance: "12.34" },
    { balance: -1 },
    { balance: Number.NaN },
    { data: { balance: 12.34 } },
    { credits: 12.34 },
  ])("rejects unsupported balance shapes: %j", (payload) => {
    expect(_parseKiloBalance(payload)).toMatchObject({ success: false });
  });

  it("reports HTTP errors without leaking the API key", async () => {
    mockResponse({
      ok: false,
      status: 401,
      text: "Unauthorized\nkilo-secret-key\u001b[31m",
    });

    const out = await queryKiloBalance();
    const error = out && !out.success ? out.error : "";

    expect(error).toBe("Kilo Gateway balance API error 401: Unauthorized [redacted]");
    expect(error).not.toContain("kilo-secret-key");
    expect(error).not.toContain("\u001b");
  });

  it("rejects oversized responses before parsing", async () => {
    mockResponse({ ok: true, status: 200, text: "x".repeat(64 * 1024 + 1) });

    const out = await queryKiloBalance();
    expect(out && !out.success ? out.error : "").toBe(
      "Kilo Gateway balance API response exceeded 65536 bytes",
    );
  });

  it("sanitizes parse and transport errors without leaking the key", async () => {
    mockResponse({ ok: true, status: 200, text: "not json kilo-secret-key\nnext" });

    const malformed = await queryKiloBalance();
    expect(malformed && !malformed.success ? malformed.error : "").toContain("Unexpected token");
    expect(JSON.stringify(malformed)).not.toContain("kilo-secret-key");

    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("timeout kilo-secret-key\nnext"));
    const timedOut = await queryKiloBalance();
    expect(timedOut && !timedOut.success ? timedOut.error : "").toBe("timeout [redacted] next");
  });
});
