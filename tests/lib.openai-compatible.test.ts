import { afterEach, describe, expect, it, vi } from "vitest";

import { queryGatewayQuota } from "../src/lib/openai-compatible.js";

function mockFetchOnce(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    ) as any,
  );
}

describe("queryGatewayQuota", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when baseURL or apiKey is missing", async () => {
    await expect(queryGatewayQuota({ baseURL: "", apiKey: "k" })).resolves.toBeNull();
    await expect(queryGatewayQuota({ baseURL: "https://gw/llm/v1", apiKey: "" })).resolves.toBeNull();
  });

  it("parses the vendor-neutral shape (tokens + cost)", async () => {
    mockFetchOnce({
      key: "course-comp318-fall26",
      tokens: { limit: 5000000, used: 250000, remaining: 4750000, resets_at: "2026-05-31T00:00:00Z" },
      cost: { currency: "USD", limit: 5.0, used: 0.42, remaining: 4.58 },
    });

    const out = await queryGatewayQuota({ baseURL: "https://gw/llm/v1", apiKey: "k" });
    expect(out && out.success).toBe(true);
    if (out && out.success) {
      expect(out.label).toBe("course-comp318-fall26");
      expect(out.tokens).toEqual({
        limit: 5000000,
        used: 250000,
        remaining: 4750000,
        resetTimeIso: "2026-05-31T00:00:00Z",
      });
      expect(out.cost).toEqual({ currency: "USD", limit: 5.0, used: 0.42, remaining: 4.58 });
    }
  });

  it("hits <baseURL><quotaPath> with a Bearer header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cost: { limit: 1, used: 0, remaining: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as any);

    await queryGatewayQuota({ baseURL: "https://gw/llm/v1/", apiKey: "secret", quotaPath: "/quota" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw/llm/v1/quota");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("parses the openrouter preset (dollars; derives remaining)", async () => {
    mockFetchOnce({ data: { label: "or-key", usage: 0.45, limit: 10.0 } });

    const out = await queryGatewayQuota({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "k",
      quotaPath: "/key",
      mapping: "openrouter",
    });
    expect(out && out.success).toBe(true);
    if (out && out.success) {
      expect(out.label).toBe("or-key");
      expect(out.tokens).toBeUndefined();
      expect(out.cost).toEqual({ currency: "USD", limit: 10.0, used: 0.45, remaining: 9.55 });
    }
  });

  it("reports a 5xx/4xx as an error", async () => {
    mockFetchOnce("Unauthorized", 401);
    const out = await queryGatewayQuota({ baseURL: "https://gw/llm/v1", apiKey: "k" });
    expect(out && out.success).toBe(false);
    if (out && !out.success) expect(out.error).toContain("401");
  });

  it("reports non-JSON as an error", async () => {
    mockFetchOnce("<html>not json</html>", 200);
    const out = await queryGatewayQuota({ baseURL: "https://gw/llm/v1", apiKey: "k" });
    expect(out && out.success).toBe(false);
    if (out && !out.success) expect(out.error).toContain("non-JSON");
  });

  it("reports an unrecognized shape as an error", async () => {
    mockFetchOnce({ something: "else" });
    const out = await queryGatewayQuota({ baseURL: "https://gw/llm/v1", apiKey: "k" });
    expect(out && out.success).toBe(false);
  });
});
