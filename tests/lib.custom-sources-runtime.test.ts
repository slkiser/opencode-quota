import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomSourceConfig } from "../src/lib/custom-sources.js";
import {
  CUSTOM_SOURCE_MAX_BODY_BYTES,
  fetchCustomSource,
  mapWithConcurrency,
} from "../src/lib/custom-sources-runtime.js";

function source(overrides: Partial<CustomSourceConfig> = {}): CustomSourceConfig {
  return {
    id: "source-one",
    providerId: "provider-one",
    label: "Source One",
    url: "https://provider.example/accounting",
    preset: "accounting-v1",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("custom source HTTP runtime", () => {
  it("maps strict accounting-v1 percent and value rows with local metadata and grouping", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        version: "accounting-v1",
        entries: [
          {
            kind: "percent",
            name: "Monthly",
            resultType: "quota",
            percentRemaining: -8,
            label: "Remaining:",
            right: "108/100",
          },
          {
            kind: "value",
            name: "Balance",
            resultType: "balance",
            value: "$12.00",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCustomSource(source(), "secret")).resolves.toEqual({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "quota",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          kind: "percent",
          name: "Source One Monthly",
          group: "Source One",
          label: "Remaining:",
          right: "108/100",
          percentRemaining: -8,
        },
        {
          accounting: {
            resultType: "balance",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          kind: "value",
          name: "Source One Balance",
          group: "Source One",
          value: "$12.00",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      source().url,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: {
          Authorization: "Bearer secret",
          Accept: "application/json",
        },
      }),
    );
  });

  it.each([
    {
      name: "unknown envelope fields",
      body: { version: "accounting-v1", entries: [], extra: true },
    },
    {
      name: "unknown row fields",
      body: {
        version: "accounting-v1",
        entries: [
          {
            kind: "percent",
            name: "Monthly",
            resultType: "quota",
            percentRemaining: 42,
            group: "remote-owned",
          },
        ],
      },
    },
    {
      name: "numeric strings",
      body: {
        version: "accounting-v1",
        entries: [
          {
            kind: "percent",
            name: "Monthly",
            resultType: "quota",
            percentRemaining: "42",
          },
        ],
      },
    },
    {
      name: "empty rows",
      body: {
        version: "accounting-v1",
        entries: [],
      },
    },
    {
      name: "percent above 100",
      body: {
        version: "accounting-v1",
        entries: [
          {
            kind: "percent",
            name: "Monthly",
            resultType: "quota",
            percentRemaining: 100.01,
          },
        ],
      },
    },
    {
      name: "too many rows",
      body: {
        version: "accounting-v1",
        entries: Array.from({ length: 101 }, () => ({
          kind: "value",
          name: "Usage",
          resultType: "usage",
          value: "1",
        })),
      },
    },
  ])("rejects the complete accounting response for $name", async ({ body }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const result = await fetchCustomSource(source(), "secret");
    expect(result.success).toBe(false);
  });

  it("accepts exactly 100 strict accounting rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          version: "accounting-v1",
          entries: Array.from({ length: 100 }, (_, index) => ({
            kind: "value",
            name: `Usage ${index}`,
            resultType: "usage",
            value: "1",
          })),
        }),
      ),
    );

    const result = await fetchCustomSource(source(), "secret");
    expect(result.success).toBe(true);
    if (result.success) expect(result.entries).toHaveLength(100);
  });

  it("accepts exact display bounds and rejects overlong name, value, label, and right", async () => {
    const exact = {
      version: "accounting-v1",
      entries: [
        {
          kind: "value",
          name: "n".repeat(80),
          resultType: "usage",
          value: "v".repeat(160),
          label: "l".repeat(80),
          right: "r".repeat(80),
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(exact)));
    const accepted = await fetchCustomSource(source(), "secret");
    expect(accepted.success).toBe(true);

    for (const field of ["name", "value", "label", "right"] as const) {
      const max = field === "value" || field === "right" ? 160 : 80;
      const body = structuredClone(exact);
      body.entries[0]![field] = "x".repeat(max + 1);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(body)));
      const rejected = await fetchCustomSource(source(), "secret");
      expect(rejected.success, field).toBe(false);
    }
  });

  it("maps OpenRouter to budget percent only for a positive limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ data: { usage: 2, limit: 10, limit_remaining: 8 } })),
    );

    await expect(
      fetchCustomSource(source({ preset: "openrouter-key-v1" }), "secret"),
    ).resolves.toEqual({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          kind: "percent",
          name: "Source One budget",
          group: "Source One",
          label: "Budget:",
          right: "$2.00/$10.00",
          percentRemaining: 80,
        },
      ],
    });
  });

  it("rejects percent rows for non-remaining accounting result types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          version: "accounting-v1",
          entries: [
            {
              kind: "percent",
              name: "Spend",
              resultType: "spend",
              percentRemaining: 50,
            },
          ],
        }),
      ),
    );
    const result = await fetchCustomSource(source(), "secret");
    expect(result.success).toBe(false);
  });

  it.each([
    ["missing usage", { data: { limit: 10 } }],
    ["missing limit", { data: { usage: 2 } }],
    ["negative usage", { data: { usage: -1, limit: null } }],
    ["negative limit", { data: { usage: 2, limit: -1 } }],
    ["numeric usage", { data: { usage: "2", limit: 10 } }],
    ["numeric limit", { data: { usage: 2, limit: "10" } }],
    ["numeric remaining", { data: { usage: 2, limit: 10, limit_remaining: "8" } }],
  ])("rejects OpenRouter %s", async (_name, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    await expect(
      fetchCustomSource(source({ preset: "openrouter-key-v1" }), "secret"),
    ).resolves.toEqual({
      success: false,
      error: "Invalid openrouter-key-v1 response",
    });
  });

  it.each([
    ["explicit", { data: { usage: 12, limit: 10, limit_remaining: -2 } }],
    ["derived", { data: { usage: 12, limit: 10 } }],
  ])(
    "preserves %s negative OpenRouter remaining instead of clamping over-budget state",
    async (_name, body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
      const result = await fetchCustomSource(source({ preset: "openrouter-key-v1" }), "secret");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.entries[0]).toEqual(expect.objectContaining({ percentRemaining: -20 }));
      }
    },
  );

  it("rejects OpenRouter remaining above its positive limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ data: { usage: 0, limit: 10, limit_remaining: 11 } })),
    );
    await expect(
      fetchCustomSource(source({ preset: "openrouter-key-v1" }), "secret"),
    ).resolves.toEqual({
      success: false,
      error: "Invalid openrouter-key-v1 response",
    });
  });

  it.each([null, 0])("maps OpenRouter usage to a spend value when limit is %s", async (limit) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { usage: 2, limit } })));

    const result = await fetchCustomSource(source({ preset: "openrouter-key-v1" }), "secret");
    expect(result).toEqual({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "spend",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          kind: "value",
          name: "Source One spend",
          group: "Source One",
          label: "Spend:",
          value: "$2.00",
        },
      ],
    });
  });

  it("rejects numeric strings in the OpenRouter preset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: { usage: "2", limit: "10" } })),
    );
    await expect(
      fetchCustomSource(source({ preset: "openrouter-key-v1" }), "secret"),
    ).resolves.toEqual({
      success: false,
      error: "Invalid openrouter-key-v1 response",
    });
  });

  it.each([
    [
      "redirect",
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      }),
      "Redirect rejected",
    ],
    [
      "non-json",
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      "Expected a JSON response",
    ],
    [
      "invalid-json",
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/problem+json" },
      }),
      "Invalid JSON response",
    ],
  ])("rejects %s responses", async (_name, response, error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(fetchCustomSource(source(), "secret")).resolves.toEqual({
      success: false,
      error,
    });
  });

  it("returns fixed HTTP and network errors without endpoint or thrown text", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("private response", {
            status: 401,
            headers: { "content-type": "text/plain" },
          }),
        )
        .mockRejectedValueOnce(new Error("https://internal.example/?token=secret failed")),
    );

    await expect(fetchCustomSource(source(), "secret")).resolves.toEqual({
      success: false,
      error: "HTTP 401",
    });
    await expect(fetchCustomSource(source(), "secret")).resolves.toEqual({
      success: false,
      error: "Failed to read accounting data",
    });
  });

  it("rejects an oversized Content-Length before consuming the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(CUSTOM_SOURCE_MAX_BODY_BYTES + 1),
          },
        }),
      ),
    );
    await expect(fetchCustomSource(source(), "secret")).resolves.toEqual({
      success: false,
      error: "Response exceeded 262144 bytes",
    });
  });

  it("uses the configured timeout and never retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchCustomSource(source(), "secret", 10);
    await vi.advanceTimersByTimeAsync(11);

    await expect(pending).resolves.toEqual({
      success: false,
      error: "Request timeout after 0s",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active while consuming the response body", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                controller.error(error);
              });
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchCustomSource(source(), "secret", 10);
    await vi.advanceTimersByTimeAsync(11);

    await expect(pending).resolves.toEqual({
      success: false,
      error: "Request timeout after 0s",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects bodies over 256 KiB without exposing response text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("x".repeat(CUSTOM_SOURCE_MAX_BODY_BYTES + 1), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(fetchCustomSource(source(), "secret")).resolves.toEqual({
      success: false,
      error: "Response exceeded 262144 bytes",
    });
  });

  it("sanitizes and bounds remote display text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          version: "accounting-v1",
          entries: [
            {
              kind: "value",
              name: "  Usage\u001b[31m  ",
              resultType: "usage",
              value: "  12\u0007 tokens  ",
              label: "  Used\u001b[31m:  ",
              right: "  12\u0007/100  ",
            },
          ],
        }),
      ),
    );
    const result = await fetchCustomSource(source(), "secret");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.entries[0]).toEqual(
        expect.objectContaining({
          name: "Source One Usage",
          label: "Used:",
          right: "12/100",
          value: "12 tokens",
        }),
      );
    }
  });

  it("limits independent work to four concurrent instances and preserves order", async () => {
    let active = 0;
    let maxActive = 0;
    const values = Array.from({ length: 9 }, (_, index) => index);
    const result = await mapWithConcurrency(values, 4, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, (9 - value) * 2));
      active -= 1;
      return value;
    });

    expect(maxActive).toBe(4);
    expect(result).toEqual(values);
  });
});
