import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import {
  fetchRemoteQuotaProvider,
  QUOTA_PROVIDER_MAX_BODY_BYTES,
  resolveQuotaProviderApiKey,
} from "../src/lib/quota-providers-remote.js";
import {
  type JsonV1Mapping,
  type RemoteApiQuotaProviderDefinition,
  validateQuotaProviders,
} from "../src/lib/quota-providers.js";
import { customRows } from "../src/providers/quota-providers.js";
import {
  NEURALWATT_LIKE_ADAPTER,
  NEURALWATT_LIKE_RESPONSE,
} from "./fixtures/quota-provider-json-v1.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

// The key tests fake OpenCode's folders under the test home and the files in them.
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: vi.fn(),
}));
vi.mock("fs/promises", () => ({ readFile: vi.fn() }));

type JsonV1Source = Extract<RemoteApiQuotaProviderDefinition, { format: "json-v1" }>;

const JSON_HEADERS = { "content-type": "application/json" };

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

const OPENROUTER = source({ format: "openrouter-key-v1" });

function jsonSource(adapter: JsonV1Source["adapter"] = NEURALWATT_LIKE_ADAPTER): JsonV1Source {
  return { ...source(), format: "json-v1", adapter };
}

/** One json-v1 mapping per metric, so each table row stays one line. */
function mappings(...metrics: JsonV1Mapping["metric"][]): JsonV1Source["adapter"] {
  return {
    mappings: metrics.map((metric) => ({ resultType: "usage", name: "Usage", metric })),
  };
}

function usedValue(path = "used"): JsonV1Mapping["metric"] {
  return { type: "value", valueType: "used", value: { path: [path] } };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Stubs fetch with one JSON body and runs the source against it. */
function fetchBody(body: unknown, definition = source()) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
  return fetchRemoteQuotaProvider(definition, "secret");
}

/** The rows of a successful reply that reach the screen, and why any were dropped. */
function shown(
  definition: RemoteApiQuotaProviderDefinition,
  result: Awaited<ReturnType<typeof fetchRemoteQuotaProvider>>,
) {
  if (!result.success) throw new Error(result.error);
  return customRows(definition, result.rows);
}

/** A json-v1 body nested `levels` objects deep around `{ used: 1 }`. */
function nested(levels: number): unknown {
  let body: unknown = { used: 1 };
  for (let index = 0; index < levels; index += 1) body = { nested: body };
  return body;
}

/** A remote custom row: provider-reported over the API, shown in the sidebar. */
function remoteRow(fields: Record<string, unknown>) {
  return { method: "remote_api", authority: "provider_reported", prominence: "primary", ...fields };
}

/** A reply the format's parser rejected. */
function invalid(error: string) {
  return { success: false, error, outcome: "invalid_response" };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

describe("quota provider remote transport", () => {
  const reply = (body: string | null, init: ResponseInit) => () => new Response(body, init);
  const badReply = { code: "bad_response" };
  it.each([
    [
      "redirect",
      reply(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      "Redirect rejected",
      "redirect_error",
      { code: "bad_response", status: 302 },
    ],
    [
      "non-json",
      reply("ok", { headers: { "content-type": "text/plain" } }),
      "Expected a JSON response",
      "invalid_content_type",
      badReply,
    ],
    [
      "JSON with a non-JSON type",
      reply("{}", { headers: { "content-type": "text/plain" } }),
      "Expected a JSON response",
      "invalid_content_type",
      undefined,
    ],
    [
      "invalid-json",
      reply("{", { headers: { "content-type": "application/problem+json" } }),
      "Invalid JSON response",
      "invalid_json",
      badReply,
    ],
    [
      "HTTP error",
      reply("private response secret", { status: 401, headers: { "content-type": "text/plain" } }),
      "HTTP 401",
      "http_error",
      { code: "login_expired", status: 401 },
    ],
    [
      "server error",
      reply("{}", { status: 503, headers: JSON_HEADERS }),
      "HTTP 503",
      "http_error",
      { code: "provider_error", status: 503 },
    ],
    [
      "network error",
      () => Promise.reject(new Error("https://internal.example/?token=secret failed")),
      "Failed to read accounting data",
      "network_error",
      { code: "network" },
    ],
    [
      "oversized Content-Length",
      reply("{}", {
        headers: { ...JSON_HEADERS, "content-length": String(QUOTA_PROVIDER_MAX_BODY_BYTES + 1) },
      }),
      "Response exceeded 262144 bytes",
      "body_too_large",
      badReply,
    ],
    [
      "oversized body",
      reply("x".repeat(QUOTA_PROVIDER_MAX_BODY_BYTES + 1), { headers: JSON_HEADERS }),
      "Response exceeded 262144 bytes",
      "body_too_large",
      badReply,
    ],
  ])("rejects %s responses with a fixed message", async (_name, respond, error, outcome, facts) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond()),
    );
    const result = await fetchRemoteQuotaProvider(source(), "secret");
    expect(result).toEqual({ success: false, error, outcome, ...(facts ? { facts } : {}) });
    expect(JSON.stringify(result)).not.toMatch(/secret|internal\.example|private response/u);
  });

  it.each([
    ["", {}],
    [" over the size cap", { "content-length": String(QUOTA_PROVIDER_MAX_BODY_BYTES + 1) }],
  ])("keeps a 429's Retry-After%s as the time to try again", async (_name, headers) => {
    vi.useFakeTimers({ now: Date.parse("2026-10-10T12:00:00.000Z") });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 429, headers: { ...headers, "Retry-After": "120" } }),
      ),
    );
    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
      success: false,
      error: "HTTP 429",
      outcome: "http_error",
      facts: {
        code: "rate_limited",
        status: 429,
        retryAtMs: Date.parse("2026-10-10T12:02:00.000Z"),
      },
    });
  });

  it.each([
    [
      "before headers",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    ],
    [
      "while reading the body",
      (_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener("abort", () => controller.error(abortError()));
              },
            }),
            { headers: JSON_HEADERS },
          ),
        ),
    ],
  ])("uses the configured timeout %s and never retries", async (_name, implementation) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(implementation);
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchRemoteQuotaProvider(source(), "secret", 10);
    await vi.advanceTimersByTimeAsync(11);

    await expect(pending).resolves.toEqual({
      success: false,
      error: "Request timeout after 0s",
      outcome: "timeout",
      facts: { code: "timeout" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a 401 whose body stalls past the timeout as a sign-in failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => controller.error(abortError()));
          },
        });
        return new Response(body, { status: 401, headers: JSON_HEADERS });
      }),
    );

    const pending = fetchRemoteQuotaProvider(source(), "secret", 10);
    await vi.advanceTimersByTimeAsync(11);

    await expect(pending).resolves.toEqual({
      success: false,
      error: "HTTP 401",
      outcome: "http_error",
      facts: { code: "login_expired", status: 401 },
    });
  });
});

describe("quota-v1", () => {
  it("maps strict percent and value rows keyed by their names, accepting `right` and `observedAtIso`", async () => {
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
            observedAtIso: "2026-01-01T00:00:00.000Z",
          },
          { kind: "value", name: "Balance", resultType: "balance", value: "$12.00" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
      success: true,
      rows: [
        remoteRow({
          key: "Monthly",
          label: "Remaining",
          type: "quota",
          window: "month",
          percentRemaining: -8,
        }),
        remoteRow({ key: "Balance", label: "Balance", type: "balance", text: "$12.00" }),
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      source().url,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: { Authorization: "Bearer secret", Accept: "application/json" },
      }),
    );
  });

  it("sanitizes and bounds remote display text", async () => {
    const result = await fetchBody({
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
    });
    expect(result.success && result.rows[0]).toEqual(
      expect.objectContaining({ key: "Usage", label: "Used", text: "12 tokens" }),
    );
  });

  const percentRow = {
    kind: "percent",
    name: "Monthly",
    resultType: "quota",
    percentRemaining: 42,
  };
  const valueRow = { kind: "value", name: "Usage", resultType: "usage", value: "1" };
  const exactBoundsRow = {
    kind: "value",
    name: "n".repeat(80),
    resultType: "usage",
    value: "v".repeat(160),
    label: "l".repeat(80),
    right: "r".repeat(80),
  };

  it.each([
    [
      "exactly 100 rows",
      Array.from({ length: 100 }, (_, i) => ({ ...valueRow, name: `Usage ${i}` })),
    ],
    ["exact display bounds", [exactBoundsRow]],
  ])("shows %s", async (_name, entries) => {
    const result = await fetchBody({ version: "quota-v1", entries });
    const screen = shown(source(), result);
    expect(screen.rows).toHaveLength(entries.length);
    expect(screen.problems).toEqual([]);
  });

  const quotaV1 = (...entries: unknown[]) => ({ version: "quota-v1", entries });
  it.each([
    ["unknown envelope fields", { ...quotaV1(), extra: true }],
    ["unknown row fields", quotaV1({ ...percentRow, group: "remote-owned" })],
    ["numeric strings", quotaV1({ ...percentRow, percentRemaining: "42" })],
    ["empty rows", quotaV1()],
    ["percent above 100", quotaV1({ ...percentRow, percentRemaining: 100.01 })],
    ["too many rows", quotaV1(...Array.from({ length: 101 }, () => valueRow))],
    ["percent rows for spend", quotaV1({ ...percentRow, resultType: "spend" })],
    ["an overlong name", quotaV1({ ...exactBoundsRow, name: "x".repeat(81) })],
    ["an overlong value", quotaV1({ ...exactBoundsRow, value: "x".repeat(161) })],
    ["an overlong label", quotaV1({ ...exactBoundsRow, label: "x".repeat(81) })],
    ["an overlong right", quotaV1({ ...exactBoundsRow, right: "x".repeat(161) })],
  ])("rejects the complete response for %s", async (_name, body) => {
    await expect(fetchBody(body)).resolves.toEqual(invalid("Invalid quota-v1 response"));
  });
});

describe("openrouter-key-v1", () => {
  it("maps a positive limit to a budget percent row", async () => {
    await expect(
      fetchBody({ data: { usage: 2, limit: 10, limit_remaining: 8 } }, OPENROUTER),
    ).resolves.toEqual({
      success: true,
      rows: [remoteRow({ key: "budget", label: "Budget", type: "budget", percentRemaining: 80 })],
    });
  });

  it.each([
    [
      "the limit window's remaining when lifetime usage exceeds it",
      { usage: 140.7, limit: 100, limit_remaining: 87.459170905 },
      87.459170905,
    ],
    ["lifetime usage when no limit window is reported", { usage: 13, limit: 100 }, 87],
    ["derived remaining", { usage: 2, limit: 10 }, 80],
    [
      "explicit negative remaining without clamping",
      { usage: 12, limit: 10, limit_remaining: -2 },
      -20,
    ],
    ["derived negative remaining without clamping", { usage: 12, limit: 10 }, -20],
  ])("shows %s in the budget row", async (_name, data, percentRemaining) => {
    await expect(fetchBody({ data }, OPENROUTER)).resolves.toEqual({
      success: true,
      rows: [expect.objectContaining({ key: "budget", percentRemaining })],
    });
  });

  it.each([
    [{ usage: 2, limit: undefined }, "$2.00"],
    [{ usage: 2, limit: null }, "$2.00"],
    [{ usage: 2, limit: 0 }, "$2.00"],
    [{ usage: 0.106921435, limit: null, limit_remaining: null }, "$0.11"],
  ])("maps %j to a spend value", async (data, value) => {
    await expect(fetchBody({ data }, OPENROUTER)).resolves.toEqual({
      success: true,
      rows: [remoteRow({ key: "spend", label: "Spend", type: "usage", text: value })],
    });
  });

  // OpenRouter's reply (sanitized) for a key without a limit.
  const UNLIMITED_KEY = {
    label: "sk-or-v1-abc...xyz",
    limit: null,
    limit_reset: null,
    limit_remaining: null,
    usage: 140.7,
    usage_daily: 0.42,
    usage_weekly: 2.9,
    usage_monthly: 12.3,
    is_free_tier: false,
  };

  it("shows this month's spend for a key without a limit", async () => {
    await expect(fetchBody({ data: UNLIMITED_KEY }, OPENROUTER)).resolves.toEqual({
      success: true,
      rows: [
        remoteRow({
          key: "spend",
          label: "This month",
          type: "usage",
          window: "month",
          text: "$12.30",
        }),
      ],
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["text", "12.3"],
    ["negative", -1],
  ])("keeps the all-time spend when usage_monthly is %s", async (_name, usageMonthly) => {
    const data = { ...UNLIMITED_KEY, usage_monthly: usageMonthly };
    await expect(fetchBody({ data }, OPENROUTER)).resolves.toEqual({
      success: true,
      rows: [remoteRow({ key: "spend", label: "Spend", type: "usage", text: "$140.70" })],
    });
  });

  it("keeps the budget row for a key with a limit, whatever this month's spend", async () => {
    const data = { ...UNLIMITED_KEY, limit: 200, limit_remaining: 150 };
    await expect(fetchBody({ data }, OPENROUTER)).resolves.toEqual({
      success: true,
      rows: [remoteRow({ key: "budget", label: "Budget", type: "budget", percentRemaining: 75 })],
    });
  });

  // Raw JSON text, so non-finite numbers such as 1e400 reach the parser.
  it.each([
    ["missing usage", '{"data":{"limit":10}}'],
    ["negative usage", '{"data":{"usage":-1,"limit":null}}'],
    ["negative limit", '{"data":{"usage":2,"limit":-1}}'],
    ["numeric usage", '{"data":{"usage":"2","limit":10}}'],
    ["numeric limit", '{"data":{"usage":2,"limit":"10"}}'],
    ["numeric remaining", '{"data":{"usage":2,"limit":10,"limit_remaining":"8"}}'],
    ["remaining above the limit", '{"data":{"usage":0,"limit":10,"limit_remaining":11}}'],
    [
      "null remaining for a positive limit",
      '{"data":{"usage":2,"limit":10,"limit_remaining":null}}',
    ],
    ["non-finite usage", '{"data":{"usage":1e400,"limit":10,"limit_remaining":8}}'],
    ["non-finite limit", '{"data":{"usage":2,"limit":1e400,"limit_remaining":8}}'],
    ["non-finite remaining", '{"data":{"usage":2,"limit":10,"limit_remaining":1e400}}'],
  ])("rejects %s", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { headers: JSON_HEADERS })),
    );
    await expect(fetchRemoteQuotaProvider(OPENROUTER, "secret")).resolves.toEqual(
      invalid("Invalid openrouter-key-v1 response"),
    );
  });
});

describe("json-v1", () => {
  it("shows every row of a definition that passed the checker with the longest label and names", async () => {
    const longest = "😀".repeat(80);
    const checked = validateQuotaProviders([
      {
        ...source({ label: longest }),
        format: "json-v1",
        adapter: {
          mappings: [
            { resultType: "usage", name: longest, metric: usedValue() },
            { resultType: "usage", name: "Other", label: longest, metric: usedValue() },
          ],
        },
      },
    ]);
    const definition = checked.value?.[0];
    if (definition?.mode !== "remote-api") throw new Error(JSON.stringify(checked.issues));

    const screen = shown(definition, await fetchBody({ used: 3 }, definition));
    expect(screen.problems).toEqual([]);
    expect(screen.rows.map((row) => [row.account, row.label, row.text])).toEqual([
      [longest, longest, "3"],
      [longest, longest, "3"],
    ]);

    // In a list, the label is cut so the longest item number still fits.
    const items = Array.from({ length: 100 }, () => ({ used: 3 }));
    const list = shown(definition, await fetchBody(items, definition));
    expect(list.problems).toEqual([]);
    expect(list.rows).toHaveLength(200);
    const cut = "😀".repeat(76);
    expect([list.rows[0]?.label, list.rows.at(-1)?.label]).toEqual([`${cut} 1`, `${cut} 100`]);
  });

  it("shows each item of a list as its own numbered row; one item keeps the plain name", async () => {
    const adapter: JsonV1Source["adapter"] = {
      rowsPath: ["plans"],
      mappings: [{ resultType: "usage", name: "Daily", label: "Daily:", metric: usedValue() }],
    };
    const plans = [{ used: 1 }, { used: 2 }, { used: 3 }];
    const list = shown(jsonSource(adapter), await fetchBody({ plans }, jsonSource(adapter)));
    expect(list.problems).toEqual([]);
    expect(list.rows.map((row) => [row.id, row.label, row.text])).toEqual([
      ["quota-providers.custom.source-one.Daily", "Daily 1", "1"],
      ["quota-providers.custom.source-one.Daily.2", "Daily 2", "2"],
      ["quota-providers.custom.source-one.Daily.3", "Daily 3", "3"],
    ]);

    const one = shown(
      jsonSource(adapter),
      await fetchBody({ plans: [{ used: 1 }] }, jsonSource(adapter)),
    );
    expect(one.rows.map((row) => [row.id, row.label])).toEqual([
      ["quota-providers.custom.source-one.Daily", "Daily"],
    ]);
  });

  it("maps the sanitized Neuralwatt-like fixture with zero, units, timestamps, and partial errors", async () => {
    const result = await fetchBody(NEURALWATT_LIKE_RESPONSE, jsonSource());
    if (!result.success) throw new Error(result.error);

    expect(result.rows).toHaveLength(21);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        remoteRow({
          key: "Tokens",
          label: "Used 1",
          type: "quota",
          percentRemaining: 100,
          resetsAt: "2026-07-31T22:00:00.000Z",
        }),
        expect.objectContaining({ key: "Used_percent.2", type: "budget", percentRemaining: -25 }),
        expect.objectContaining({ key: "Spend_budget.2", percentRemaining: -20 }),
        expect.objectContaining({ key: "Balance", type: "balance", text: "-$3.50" }),
        expect.objectContaining({ key: "Spend", type: "usage" }),
        expect.objectContaining({ key: "Requests", type: "quota" }),
        expect.objectContaining({ key: "Status", type: "status", text: "Ready" }),
        expect.objectContaining({ key: "Status.3", label: "Status 3", text: "Partial" }),
      ]),
    );
    // Each plan's rows are numbered, so every one is shown.
    const screen = shown(jsonSource(), result);
    expect(screen.rows).toHaveLength(21);
    expect(screen.problems).toEqual([]);
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
    const adapter: JsonV1Source["adapter"] = {
      mappings: [
        { resultType: "usage", name: "Used", metric: usedValue() },
        {
          resultType: "quota",
          name: "Limit",
          metric: { type: "value", valueType: "limit", value: { path: ["limit"] } },
        },
        {
          resultType: "quota",
          name: "Remaining",
          metric: { type: "value", valueType: "remaining", value: { path: ["remaining"] } },
        },
        {
          resultType: "quota",
          name: "Literal percent",
          resetTime: { literal: 0, encoding: "unix-milliseconds" },
          metric: { type: "percentage", percentage: { literal: -5 }, meaning: "remaining" },
        },
        {
          resultType: "status",
          name: "Literal status",
          metric: { type: "status", value: { literal: "Ready" } },
        },
      ],
    };

    for (const body of [
      { used: 0, limit: 10, remaining: -2 },
      [
        { used: 0, limit: 10, remaining: -2 },
        { used: 2, limit: 10, remaining: 8 },
      ],
    ]) {
      const result = await fetchBody(body, jsonSource(adapter));
      expect(result.success && result.rows.slice(0, 5)).toEqual([
        expect.objectContaining({ text: "0" }),
        expect.objectContaining({ text: "10" }),
        expect.objectContaining({ text: "-2" }),
        expect.objectContaining({ percentRemaining: -5, resetsAt: "1970-01-01T00:00:00.000Z" }),
        expect.objectContaining({ text: "Ready" }),
      ]);
    }
  });

  it("fails safely when no candidate succeeds without exposing response data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ value: "SUPER_SECRET_BODY_VALUE" })),
    );
    const result = await fetchRemoteQuotaProvider(
      jsonSource(mappings(usedValue("value"))),
      "secret-key",
    );
    expect(result).toEqual(
      invalid("Invalid json-v1 response: adapter.mappings[0].metric.value had wrong type at row 0"),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /SUPER_SECRET_BODY_VALUE|secret-key|provider\.example/,
    );
  });

  it.each([
    ["$", "prefix", 0.313942875, "$0.31"],
    ["$", "suffix", 1234.567, "$1,234.57"],
    ["USD", "suffix", -3.5, "-$3.50"],
    ["USD", "prefix", 0.001, "$0.00"],
    ["usd", "suffix", 95.5, "$95.50"],
    ["Usd", "suffix", 95.5, "$95.50"],
  ] as const)(
    "shows a value in %j (%s) as money, like built-in money",
    async (unit, unitPosition, balance, expected) => {
      const adapter: JsonV1Source["adapter"] = {
        mappings: [
          {
            resultType: "balance",
            name: "Balance",
            unit,
            unitPosition,
            metric: { type: "value", valueType: "balance", value: { path: ["balance"] } },
          },
        ],
      };
      await expect(fetchBody({ balance }, jsonSource(adapter))).resolves.toEqual({
        success: true,
        rows: [expect.objectContaining({ key: "Balance", text: expected })],
      });
    },
  );

  it.each([
    ["tokens", "suffix", { path: ["used"] }, 0.30000000000000004, "0.3 tokens"],
    ["tokens", "suffix", { path: ["used"], divideBy: 100 }, 0.7, "0.007 tokens"],
    ["€", "prefix", { path: ["used"] }, 0.313942875, "€0.313942875"],
    [undefined, undefined, { path: ["used"] }, 1e-7, "0.0000001"],
  ] as const)(
    "shows a value in %j (%s) without float noise",
    async (unit, unitPosition, value, used, expected) => {
      const adapter: JsonV1Source["adapter"] = {
        mappings: [
          {
            resultType: "usage",
            name: "Used",
            ...(unit && unitPosition ? { unit, unitPosition } : {}),
            metric: { type: "value", valueType: "used", value },
          },
        ],
      };
      await expect(fetchBody({ used }, jsonSource(adapter))).resolves.toEqual({
        success: true,
        rows: [expect.objectContaining({ key: "Used", text: expected })],
      });
    },
  );

  it.each([
    ["95.50", "450", ["$95.50", "4.5"]],
    [" -3 ", "0", ["-$3.00", "0"]],
    ["0.25", 450, ["$0.25", "4.5"]],
  ] as const)("reads plain decimal text %j as a number", async (balance, totalUsed, expected) => {
    const adapter: JsonV1Source["adapter"] = {
      mappings: [
        {
          resultType: "balance",
          name: "Balance",
          unit: "USD",
          unitPosition: "suffix",
          metric: { type: "value", valueType: "balance", value: { path: ["balance"] } },
        },
        {
          resultType: "spend",
          name: "Spend",
          metric: {
            type: "value",
            valueType: "spend",
            value: { path: ["total_used"], divideBy: 100 },
          },
        },
      ],
    };
    await expect(
      fetchBody({ balance, total_used: totalUsed }, jsonSource(adapter)),
    ).resolves.toEqual({
      success: true,
      rows: [
        expect.objectContaining({ key: "Balance", text: expected[0] }),
        expect.objectContaining({ key: "Spend", text: expected[1] }),
      ],
    });
  });

  it.each([
    ...["95.50 USD", "1e3", "", "  ", "NaN", "Infinity", "0x10", "+5", ".5", "5."].map(
      (balance) => [balance, "had wrong type"] as const,
    ),
    ["1".repeat(17), "exceeded the numeric magnitude limit"] as const,
  ])("rejects number text %j", async (balance, issue) => {
    const adapter = mappings({ type: "value", valueType: "balance", value: { path: ["balance"] } });
    await expect(fetchBody({ balance }, jsonSource(adapter))).resolves.toEqual(
      invalid(`Invalid json-v1 response: adapter.mappings[0].metric.value ${issue} at row 0`),
    );
  });

  it("caps detailed partial errors and adds one fixed omission summary", async () => {
    const body = [{ used: 0 }, ...Array.from({ length: 99 }, () => null)];
    const result = await fetchBody(body, jsonSource(mappings(usedValue())));
    if (!result.success) throw new Error(result.error);
    expect(result.rows).toHaveLength(1);
    expect(result.rowErrors).toHaveLength(17);
    expect(result.rowErrors?.at(-1)).toBe("Additional json-v1 mapping errors omitted");
  });

  it.each([
    [
      "a list of exactly 100 items",
      mappings(usedValue()),
      Array.from({ length: 100 }, (_, used) => ({ used })),
      100,
    ],
    [
      "a row for every item and mapping, past 100 rows",
      mappings(usedValue(), { type: "value", valueType: "limit", value: { path: ["limit"] } }),
      Array.from({ length: 51 }, () => ({ used: 0, limit: 10 })),
      102,
    ],
    [
      "exactly 32 container levels",
      mappings({ type: "value", valueType: "used", value: { literal: 1 } }),
      nested(31),
      1,
    ],
  ])("accepts %s", async (_name, adapter, body, count) => {
    const result = await fetchBody(body, jsonSource(adapter));
    expect(result.success && result.rows).toHaveLength(count);
  });

  const rowsAt = (...rowsPath: string[]) => ({
    rowsPath,
    mappings: mappings(usedValue()).mappings,
  });
  it.each([
    [
      "an empty selected row array",
      rowsAt("data", "rows"),
      { data: { rows: [] } },
      "selected rows must contain 1-100 elements",
    ],
    [
      "a 101-element selected row array",
      rowsAt("data", "rows"),
      { data: { rows: Array.from({ length: 101 }, () => ({ used: 0 })) } },
      "selected rows must contain 1-100 elements",
    ],
    [
      "non-finite percentages derived from finite operands",
      mappings({ type: "used-limit", used: { literal: 1 }, limit: { literal: Number.MIN_VALUE } }),
      {},
      "adapter.mappings[0].metric.limit produced a non-finite percentage at row 0",
    ],
    [
      "finite derived percentages beyond the numeric magnitude limit",
      mappings({ type: "spend-budget", spend: { literal: 1e15 }, budget: { literal: 1e-10 } }),
      {},
      "adapter.mappings[0].metric.budget produced a percentage beyond the numeric magnitude limit at row 0",
    ],
    [
      "nesting beyond 32 container levels",
      mappings({ type: "value", valueType: "used", value: { literal: 1 } }),
      nested(32),
      "nesting depth exceeded 32",
    ],
    ["a rowsPath on an array root", rowsAt("rows"), [], "adapter.rowsPath requires an object root"],
    ["a missing rowsPath", rowsAt("rows"), {}, "adapter.rowsPath was missing"],
    [
      "a rowsPath through a non-object",
      rowsAt("rows", "list"),
      { rows: 5 },
      "adapter.rowsPath had wrong type",
    ],
    [
      "a rowsPath that is not an array",
      rowsAt("rows"),
      { rows: {} },
      "adapter.rowsPath did not resolve to an array",
    ],
    ["a scalar root", mappings(usedValue()), 5, "expected an object or array root"],
  ])("rejects %s", async (_name, adapter, body, message) => {
    await expect(fetchBody(body, jsonSource(adapter as JsonV1Source["adapter"]))).resolves.toEqual(
      invalid(`Invalid json-v1 response: ${message}`),
    );
  });

  const lit = (literal: number) => ({ literal });
  it.each([
    [{ type: "used-limit", used: lit(-1), limit: lit(10) }, "metric.used must be non-negative"],
    [{ type: "used-limit", used: lit(1), limit: lit(0) }, "metric.limit must be greater than zero"],
    [{ type: "spend-budget", spend: lit(-1), budget: lit(5) }, "metric.spend must be non-negative"],
    [
      { type: "remaining-limit", remaining: lit(11), limit: lit(10) },
      "metric.remaining must not exceed limit",
    ],
    [
      { type: "remaining-budget", remaining: lit(1), budget: lit(0) },
      "metric.budget must be greater than zero",
    ],
    [
      { type: "percentage", percentage: lit(101), meaning: "remaining" },
      "metric.percentage must not exceed 100 for remaining meaning",
    ],
    [
      { type: "percentage", percentage: lit(-1), meaning: "used" },
      "metric.percentage must be non-negative for used meaning",
    ],
    [{ type: "value", valueType: "spend", value: lit(-1) }, "metric.value must be non-negative"],
    [{ type: "status", value: { path: ["count"] } }, "metric.value had wrong type"],
    [
      { type: "status", value: { path: ["blank"] } },
      "metric.value did not resolve to bounded display text",
    ],
  ] as const)("rejects the metric %j", async (metric, issue) => {
    const adapter = mappings(metric as JsonV1Mapping["metric"]);
    await expect(fetchBody({ count: 1, blank: "  " }, jsonSource(adapter))).resolves.toEqual(
      invalid(`Invalid json-v1 response: adapter.mappings[0].${issue} at row 0`),
    );
  });
});

describe("quota provider key resolution", () => {
  // Never created: every config file read and existence check is faked by `files`.
  const fakeRoot = join(tmpdir(), "opencode-quota-remote-keys");
  const trustedJson = join(fakeRoot, "config", "opencode", "opencode.json");
  const trustedJsonc = join(fakeRoot, "config", "opencode", "opencode.jsonc");
  /** The session's folder. */
  const project = join(fakeRoot, "project");

  /** Fakes the files on disk: path -> JSON content. Every other path is missing. */
  function files(contents: Record<string, unknown>): void {
    vi.mocked(existsSync).mockImplementation((path) => String(path) in contents);
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (String(path) in contents) return JSON.stringify(contents[String(path)]);
      throw new Error("missing");
    });
  }

  const providerKeys = (keys: Record<string, string>) => ({
    provider: Object.fromEntries(
      Object.entries(keys).map(([id, apiKey]) => [id, { options: { apiKey } }]),
    ),
  });

  beforeEach(() => {
    files({});
    vi.stubEnv("HOME", fakeRoot);
    vi.stubEnv("XDG_CONFIG_HOME", join(fakeRoot, "config"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", undefined);
    vi.stubEnv("OPENCODE_CONFIG", undefined);
  });

  it("uses explicit environment auth before trusted config", async () => {
    vi.stubEnv("EXPLICIT_KEY", "env-secret");
    files({ [trustedJson]: providerKeys({ "provider-one": "config-secret" }) });

    await expect(
      resolveQuotaProviderApiKey(source({ apiKeyEnv: "EXPLICIT_KEY" }), project),
    ).resolves.toMatchObject({ key: "env-secret", source: "env" });
  });

  it("uses only the exact providerId in trusted global provider config", async () => {
    files({
      [trustedJson]: providerKeys({
        "provider-one-alias": "neighbor-secret",
        "provider-one": "exact-secret",
      }),
    });

    await expect(resolveQuotaProviderApiKey(source(), project)).resolves.toMatchObject({
      key: "exact-secret",
      source: "opencode.json",
    });
  });

  it("expands a global config env template only for exact explicit apiKeyEnv", async () => {
    vi.stubEnv("EXPLICIT_KEY", "explicit-secret");
    vi.stubEnv("OTHER_KEY", "other-secret");
    files({ [trustedJsonc]: providerKeys({ "provider-one": "{env:OTHER_KEY}" }) });

    const result = await resolveQuotaProviderApiKey(source({ apiKeyEnv: "EXPLICIT_KEY" }), project);
    expect(result.key).toBe("explicit-secret");

    vi.stubEnv("EXPLICIT_KEY", undefined);
    const disallowed = await resolveQuotaProviderApiKey(
      source({ apiKeyEnv: "EXPLICIT_KEY" }),
      project,
    );
    expect(disallowed.key).toBeUndefined();
    expect(JSON.stringify(disallowed)).not.toContain("other-secret");
  });

  it("reads the session folder's config, never another folder's or derived env names", async () => {
    vi.stubEnv("PROVIDER_ONE_API_KEY", "derived-secret");
    const projectJson = join(project, "opencode.json");
    files({
      [projectJson]: providerKeys({ "provider-one": "project-secret" }),
      [join(fakeRoot, "other", "opencode.json")]: providerKeys({ "provider-one": "other-secret" }),
    });

    const result = await resolveQuotaProviderApiKey(source(), project);
    expect(result).toMatchObject({ key: "project-secret", source: "opencode.json" });
    expect(result.checkedPaths).toEqual([projectJson]);
    expect(JSON.stringify(result)).not.toMatch(/other-secret|derived-secret/);
  });

  it("reads only a key login for the providerId and never resolves an OAuth sign-in", async () => {
    const integration = createFakeIntegration([
      {
        integrationId: "opencode",
        id: "cred_console",
        label: "default",
        registered: true,
        method: "oauth",
        value: { type: "oauth", methodID: "device", access: "console-access", expires: 0 },
      },
      {
        integrationId: "provider-one",
        id: "cred_provider_one",
        label: "default",
        registered: true,
        method: "key",
        value: { type: "key", key: "db-secret" },
      },
    ]);
    const unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));
    try {
      const signIn = await resolveQuotaProviderApiKey(source({ providerId: "opencode" }), project);
      expect(signIn.key).toBeUndefined();
      expect(integration.connection.resolve).not.toHaveBeenCalled();

      const keyLogin = await resolveQuotaProviderApiKey(source(), project);
      expect(keyLogin).toMatchObject({ key: "db-secret", source: "opencode.db" });
    } finally {
      unbind();
      notifyCredentialsChanged();
    }
  });

  it("reads no key and sends no request for a switched-off provider, even when called directly", async () => {
    vi.stubEnv("EXPLICIT_KEY", "env-secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const off = source({ apiKeyEnv: "EXPLICIT_KEY", enabled: false });

    await expect(resolveQuotaProviderApiKey(off, project)).resolves.toEqual({
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    });
    await expect(fetchRemoteQuotaProvider(off, "key")).resolves.toEqual({
      success: false,
      error: "Provider is switched off",
      outcome: "switched_off",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
