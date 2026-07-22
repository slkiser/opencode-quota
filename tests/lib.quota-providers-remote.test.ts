import { afterEach, describe, expect, it, vi } from "vitest";

import type { RemoteApiQuotaProviderDefinition } from "../src/lib/quota-providers.js";
import {
  QUOTA_PROVIDER_MAX_BODY_BYTES,
  fetchRemoteQuotaProvider,
  mapWithConcurrency,
} from "../src/lib/quota-providers-remote.js";
import {
  NEURALWATT_LIKE_ADAPTER,
  NEURALWATT_LIKE_RESPONSE,
} from "./fixtures/quota-provider-json-v1.js";

function source(
  overrides: Partial<RemoteApiQuotaProviderDefinition> = {},
): RemoteApiQuotaProviderDefinition {
  return {
    id: "source-one",
    providerId: "provider-one",
    label: "Source One",
    url: "https://provider.example/accounting",
    mode: "remote-api",
    format: "quota-v1",
    ...overrides,
  };
}

function jsonSource(
  adapter = NEURALWATT_LIKE_ADAPTER,
): Extract<RemoteApiQuotaProviderDefinition, { format: "json-v1" }> {
  return {
    id: "json-source",
    providerId: "provider-one",
    label: "JSON Source",
    url: "https://provider.example/quota",
    mode: "remote-api",
    format: "json-v1",
    adapter,
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

describe("quota provider remote runtime", () => {
  it("maps strict quota-v1 percent and value rows with local metadata and grouping", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        version: "quota-v1",
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

    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
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
      body: { version: "quota-v1", entries: [], extra: true },
    },
    {
      name: "unknown row fields",
      body: {
        version: "quota-v1",
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
        version: "quota-v1",
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
        version: "quota-v1",
        entries: [],
      },
    },
    {
      name: "percent above 100",
      body: {
        version: "quota-v1",
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
        version: "quota-v1",
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
    const result = await fetchRemoteQuotaProvider(source(), "secret");
    expect(result.success).toBe(false);
  });

  it("accepts exactly 100 strict accounting rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          version: "quota-v1",
          entries: Array.from({ length: 100 }, (_, index) => ({
            kind: "value",
            name: `Usage ${index}`,
            resultType: "usage",
            value: "1",
          })),
        }),
      ),
    );

    const result = await fetchRemoteQuotaProvider(source(), "secret");
    expect(result.success).toBe(true);
    if (result.success) expect(result.entries).toHaveLength(100);
  });

  it("accepts exact display bounds and rejects overlong name, value, label, and right", async () => {
    const exact = {
      version: "quota-v1",
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
    const accepted = await fetchRemoteQuotaProvider(source(), "secret");
    expect(accepted.success).toBe(true);

    for (const field of ["name", "value", "label", "right"] as const) {
      const max = field === "value" || field === "right" ? 160 : 80;
      const body = structuredClone(exact);
      body.entries[0]![field] = "x".repeat(max + 1);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(body)));
      const rejected = await fetchRemoteQuotaProvider(source(), "secret");
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
      fetchRemoteQuotaProvider(source({ format: "openrouter-key-v1" }), "secret"),
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
          version: "quota-v1",
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
    const result = await fetchRemoteQuotaProvider(source(), "secret");
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
      fetchRemoteQuotaProvider(source({ format: "openrouter-key-v1" }), "secret"),
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
      const result = await fetchRemoteQuotaProvider(
        source({ format: "openrouter-key-v1" }),
        "secret",
      );
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
      fetchRemoteQuotaProvider(source({ format: "openrouter-key-v1" }), "secret"),
    ).resolves.toEqual({
      success: false,
      error: "Invalid openrouter-key-v1 response",
    });
  });

  it.each([null, 0])("maps OpenRouter usage to a spend value when limit is %s", async (limit) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { usage: 2, limit } })));

    const result = await fetchRemoteQuotaProvider(
      source({ format: "openrouter-key-v1" }),
      "secret",
    );
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
      fetchRemoteQuotaProvider(source({ format: "openrouter-key-v1" }), "secret"),
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
    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
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

    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
      success: false,
      error: "HTTP 401",
    });
    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
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
            "content-length": String(QUOTA_PROVIDER_MAX_BODY_BYTES + 1),
          },
        }),
      ),
    );
    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
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

    const pending = fetchRemoteQuotaProvider(source(), "secret", 10);
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

    const pending = fetchRemoteQuotaProvider(source(), "secret", 10);
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
        new Response("x".repeat(QUOTA_PROVIDER_MAX_BODY_BYTES + 1), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
      success: false,
      error: "Response exceeded 262144 bytes",
    });
  });

  it("sanitizes and bounds remote display text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          version: "quota-v1",
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
    const result = await fetchRemoteQuotaProvider(source(), "secret");
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

  it("maps the sanitized Neuralwatt-like fixture with zero, units, timestamps, and partial errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(NEURALWATT_LIKE_RESPONSE)));

    const result = await fetchRemoteQuotaProvider(jsonSource(), "secret");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.entries).toHaveLength(21);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "JSON Source Tokens",
          percentRemaining: 100,
          right: "0/10 tokens",
          resetTimeIso: "2026-07-31T22:00:00.000Z",
          accounting: expect.objectContaining({
            observedAtIso: new Date(1_784_678_400_000).toISOString(),
          }),
        }),
        expect.objectContaining({
          name: "JSON Source Used percent",
          percentRemaining: -25,
        }),
        expect.objectContaining({
          name: "JSON Source Spend budget",
          percentRemaining: -20,
          right: "$30/$25",
        }),
        expect.objectContaining({
          name: "JSON Source Balance",
          value: "$-3.5",
        }),
        expect.objectContaining({
          name: "JSON Source Status",
          value: "Ready",
        }),
      ]),
    );
    expect(result.rowErrors).toHaveLength(15);
    expect(result.rowErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("did not resolve to a valid timestamp at row 2"),
        expect.stringContaining("was null at row 2"),
        expect.stringContaining("was missing at row 2"),
        expect.stringContaining("had wrong type at row 2"),
        expect.stringContaining("requires an object row at row 3"),
      ]),
    );
  });

  it("supports object and array roots, literals, and all numeric value variants", async () => {
    const adapter = {
      mappings: [
        {
          resultType: "usage",
          name: "Used",
          metric: { type: "value", valueType: "used", value: { path: ["used"] } },
        },
        {
          resultType: "quota",
          name: "Limit",
          metric: { type: "value", valueType: "limit", value: { path: ["limit"] } },
        },
        {
          resultType: "quota",
          name: "Remaining",
          metric: {
            type: "value",
            valueType: "remaining",
            value: { path: ["remaining"] },
          },
        },
        {
          resultType: "quota",
          name: "Literal percent",
          resetTime: { literal: 0, encoding: "unix-milliseconds" },
          metric: {
            type: "percentage",
            percentage: { literal: -5 },
            meaning: "remaining",
          },
        },
        {
          resultType: "status",
          name: "Literal status",
          metric: { type: "status", value: { literal: "Ready" } },
        },
      ],
    } as const;

    for (const body of [
      { used: 0, limit: 10, remaining: -2 },
      [
        { used: 0, limit: 10, remaining: -2 },
        { used: 2, limit: 10, remaining: 8 },
      ],
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
      const result = await fetchRemoteQuotaProvider(jsonSource(adapter), "secret");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.entries.slice(0, 5)).toEqual([
          expect.objectContaining({ value: "0" }),
          expect.objectContaining({ value: "10" }),
          expect.objectContaining({ value: "-2" }),
          expect.objectContaining({
            percentRemaining: -5,
            resetTimeIso: "1970-01-01T00:00:00.000Z",
          }),
          expect.objectContaining({ value: "Ready" }),
        ]);
      }
    }
  });

  it("fails safely when no json-v1 candidate succeeds without exposing response data", async () => {
    const body = { value: "SUPER_SECRET_BODY_VALUE" };
    const adapter = {
      mappings: [
        {
          resultType: "usage",
          name: "Usage",
          metric: { type: "value", valueType: "used", value: { path: ["value"] } },
        },
      ],
    } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const result = await fetchRemoteQuotaProvider(jsonSource(adapter), "secret-key");
    expect(result).toEqual({
      success: false,
      error: "Invalid json-v1 response: adapter.mappings[0].metric.value had wrong type at row 0",
    });
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_BODY_VALUE");
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(JSON.stringify(result)).not.toContain("provider.example");
  });

  it("caps detailed partial errors and adds one fixed omission summary", async () => {
    const adapter = {
      mappings: [
        {
          resultType: "usage",
          name: "Usage",
          metric: { type: "value", valueType: "used", value: { path: ["used"] } },
        },
      ],
    } as const;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse([{ used: 0 }, ...Array.from({ length: 99 }, () => null)])),
    );

    const result = await fetchRemoteQuotaProvider(jsonSource(adapter), "secret");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.entries).toHaveLength(1);
      expect(result.rowErrors).toHaveLength(17);
      expect(result.rowErrors?.at(-1)).toBe("Additional json-v1 mapping errors omitted");
    }
  });

  it("accepts exactly 100 successful json-v1 entries", async () => {
    const adapter = {
      mappings: [
        {
          resultType: "usage",
          name: "Used",
          metric: { type: "value", valueType: "used", value: { path: ["used"] } },
        },
      ],
    } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(Array.from({ length: 100 }, (_, used) => ({ used })))),
    );

    const result = await fetchRemoteQuotaProvider(jsonSource(adapter), "secret");
    expect(result.success).toBe(true);
    if (result.success) expect(result.entries).toHaveLength(100);
  });

  it.each([
    { name: "empty", rows: [] },
    { name: "101-element", rows: Array.from({ length: 101 }, () => ({ used: 0 })) },
  ])("rejects a $name selected json-v1 row array", async ({ rows }) => {
    const adapter = {
      rowsPath: ["data", "rows"],
      mappings: [
        {
          resultType: "usage",
          name: "Used",
          metric: { type: "value", valueType: "used", value: { path: ["used"] } },
        },
      ],
    } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { rows } })));

    await expect(fetchRemoteQuotaProvider(jsonSource(adapter), "secret")).resolves.toEqual({
      success: false,
      error: "Invalid json-v1 response: selected rows must contain 1-100 elements",
    });
  });

  it("rejects a 101st successful json-v1 entry instead of truncating", async () => {
    const adapter = {
      mappings: [
        {
          resultType: "usage",
          name: "Used",
          metric: { type: "value", valueType: "used", value: { path: ["used"] } },
        },
        {
          resultType: "quota",
          name: "Limit",
          metric: { type: "value", valueType: "limit", value: { path: ["limit"] } },
        },
      ],
    } as const;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(Array.from({ length: 51 }, () => ({ used: 0, limit: 10 }))),
        ),
    );

    await expect(fetchRemoteQuotaProvider(jsonSource(adapter), "secret")).resolves.toEqual({
      success: false,
      error: "Invalid json-v1 response: more than 100 entries were produced",
    });
  });

  it("rejects non-finite percentages derived from finite operands", async () => {
    const adapter = {
      mappings: [
        {
          resultType: "quota",
          name: "Quota",
          metric: {
            type: "used-limit",
            used: { literal: 1 },
            limit: { literal: Number.MIN_VALUE },
          },
        },
      ],
    } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));

    await expect(fetchRemoteQuotaProvider(jsonSource(adapter), "secret")).resolves.toEqual({
      success: false,
      error:
        "Invalid json-v1 response: adapter.mappings[0].metric.limit produced a non-finite percentage at row 0",
    });
  });

  it("rejects finite derived percentages beyond the numeric magnitude limit", async () => {
    const adapter = {
      mappings: [
        {
          resultType: "budget",
          name: "Budget",
          metric: {
            type: "spend-budget",
            spend: { literal: 1e15 },
            budget: { literal: 1e-10 },
          },
        },
      ],
    } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));

    await expect(fetchRemoteQuotaProvider(jsonSource(adapter), "secret")).resolves.toEqual({
      success: false,
      error:
        "Invalid json-v1 response: adapter.mappings[0].metric.budget produced a percentage beyond the numeric magnitude limit at row 0",
    });
  });

  it("accepts json-v1 responses at exactly 32 container levels", async () => {
    let body: unknown = { used: 1 };
    for (let index = 0; index < 31; index += 1) body = { nested: body };
    const adapter = {
      mappings: [
        {
          resultType: "usage",
          name: "Usage",
          metric: { type: "value", valueType: "used", value: { literal: 1 } },
        },
      ],
    } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const result = await fetchRemoteQuotaProvider(jsonSource(adapter), "secret");
    expect(result.success).toBe(true);
    if (result.success) expect(result.entries).toHaveLength(1);
  });

  it("rejects json-v1 response nesting beyond 32 container levels", async () => {
    let body: unknown = { used: 1 };
    for (let index = 0; index < 32; index += 1) body = { nested: body };
    const adapter = {
      mappings: [
        {
          resultType: "usage",
          name: "Usage",
          metric: { type: "value", valueType: "used", value: { literal: 1 } },
        },
      ],
    } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    await expect(fetchRemoteQuotaProvider(jsonSource(adapter), "secret")).resolves.toEqual({
      success: false,
      error: "Invalid json-v1 response: nesting depth exceeded 32",
    });
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
