import { describe, it, expect } from "vitest";
import { validateRemoteDefinitions } from "../src/lib/quota-provider-definitions.js";
import { mapRemoteQuotaResponse } from "../src/lib/quota-providers-remote.js";
const definition = () => ({
  id: "custom-fixture",
  providerId: "fixture",
  label: "Fixture",
  mode: "remote-api",
  url: "https://quota.example.test/status",
  apiKeyEnv: "FIXTURE_TOKEN",
  format: "json-v1",
  adapter: {
    mappings: [
      {
        name: "Quota",
        resultType: "quota",
        unit: "requests",
        metric: { type: "used-limit", used: { path: ["used"] }, limit: { literal: 100 } },
      },
    ],
  },
});
describe("bounded custom quota definitions", () => {
  it.each(["method", "headers", "script", "apiKey"])(
    "rejects unsupported %s instead of executing or persisting it",
    (key) => {
      expect(() =>
        validateRemoteDefinitions([{ ...definition(), [key]: "secret-or-expression" }]),
      ).toThrow();
    },
  );
  it.each([
    "http://remote.example.test/quota",
    "https://user:password@example.test/quota",
    "https://example.test/quota#fragment",
    "https://example.test/quota?api_key=secret",
    "file:///tmp/quota",
    "https://example.test/quota?authorization=secret",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validateRemoteDefinitions([{ ...definition(), url }])).toThrow();
  });
  it("permits explicit loopback HTTP, bounds source count and rejects colliding/builtin ids", () => {
    expect(
      validateRemoteDefinitions([{ ...definition(), url: "http://127.0.0.1:1234/quota" }]),
    ).toHaveLength(1);
    expect(() => validateRemoteDefinitions([{ ...definition(), id: "openai" }])).toThrow();
    expect(() => validateRemoteDefinitions([definition(), definition()])).toThrow();
    expect(() =>
      validateRemoteDefinitions(
        Array.from({ length: 17 }, (_, i) => ({ ...definition(), id: `custom-${i}` })),
      ),
    ).toThrow();
  });
  it.each(["__proto__", "constructor", "prototype"])(
    "rejects prototype path segment %s",
    (segment) => {
      const source = definition();
      source.adapter.mappings[0].metric.used.path = [segment];
      expect(() => validateRemoteDefinitions([source])).toThrow();
    },
  );
  it("bounds paths/mappings, rejects expressions and does not coerce numeric strings", () => {
    const source = definition();
    source.adapter.mappings[0].metric.used.path = Array(9).fill("x");
    expect(() => validateRemoteDefinitions([source])).toThrow();
    expect(() =>
      validateRemoteDefinitions([
        {
          ...definition(),
          adapter: { mappings: Array(17).fill(definition().adapter.mappings[0]) },
        },
      ]),
    ).toThrow();
    expect(() =>
      validateRemoteDefinitions([
        {
          ...definition(),
          adapter: {
            mappings: [
              {
                name: "x",
                resultType: "quota",
                metric: {
                  type: "percentage",
                  percentage: { expression: "process.env.FIXTURE_TOKEN" },
                  meaning: "remaining",
                },
              },
            ],
          },
        },
      ]),
    ).toThrow();
    const mapped = mapRemoteQuotaResponse(validateRemoteDefinitions([definition()])[0], {
      used: "25",
    });
    expect(mapped.errors).toHaveLength(1);
    expect(mapped.entries[0]).toMatchObject({ kind: "value", value: "Unknown" });
  });
  it("maps all arithmetic variants without inventing a percentage for zero denominator", () => {
    const metrics = [
      { type: "percentage", percentage: { path: ["n"] }, meaning: "used" },
      { type: "used-limit", used: { path: ["n"] }, limit: { literal: 100 } },
      { type: "remaining-limit", remaining: { path: ["n"] }, limit: { literal: 100 } },
      { type: "spend-budget", spend: { path: ["n"] }, budget: { literal: 100 } },
      { type: "remaining-budget", remaining: { path: ["n"] }, budget: { literal: 100 } },
    ];
    for (const [index, metric] of metrics.entries()) {
      const def = validateRemoteDefinitions([
        {
          ...definition(),
          adapter: { mappings: [{ name: "Cap", resultType: "budget", unit: "USD", metric }] },
        },
      ])[0];
      expect(mapRemoteQuotaResponse(def, { n: 25 }).entries[0]).toMatchObject({
        percentRemaining: [75, 75, 25, 75, 25][index],
      });
    }
    const zero = definition();
    zero.adapter.mappings[0].metric.limit.literal = 0;
    expect(
      mapRemoteQuotaResponse(validateRemoteDefinitions([zero])[0], { used: 25 }).entries[0],
    ).toMatchObject({ value: "Unknown" });
  });
  it("maps typed amounts, source time, reset time and explicit status without evaluating payload text", () => {
    const def = validateRemoteDefinitions([
      {
        ...definition(),
        adapter: {
          rowsPath: ["rows"],
          mappings: [
            {
              name: "Balance",
              resultType: "balance",
              unit: "USD",
              metric: {
                type: "value",
                valueType: "balance",
                value: { path: ["amount"], divideBy: 100 },
              },
              observedTime: { path: ["at"], encoding: "unix-seconds" },
              resetTime: { literal: "2026-11-01T00:00:00Z", encoding: "iso-8601" },
            },
            {
              name: "State",
              resultType: "status",
              metric: { type: "status", value: { path: ["state"] } },
            },
          ],
        },
      },
    ])[0];
    const mapped = mapRemoteQuotaResponse(def, {
      rows: [{ amount: -125, state: "unlimited", at: 1792065600 }],
    });
    expect(mapped.entries[0]).toMatchObject({ kind: "value", value: "USD -1.25" });
    expect(mapped.accounting?.rows[0].freshness.kind).toBe("observed");
    expect(mapped.accounting?.rows[0].window.kind).toBe("identified");
    expect(mapped.entries[1]).toMatchObject({ value: "Unlimited" });
    expect(() =>
      mapRemoteQuotaResponse(def, {
        rows: Array(33).fill({ amount: 1, state: "available", at: 1792065600 }),
      }),
    ).toThrow();
  });
  it("keeps protocol value strings unparsed, preserves negative quota and rejects malformed envelopes", () => {
    const def = validateRemoteDefinitions([
      { ...definition(), format: "quota-v1", adapter: undefined },
    ])[0];
    const mapped = mapRemoteQuotaResponse(def, {
      version: "quota-v1",
      entries: [
        {
          kind: "value",
          name: "Balance (unit undeclared)",
          resultType: "balance",
          value: "$12.50",
        },
        {
          kind: "percent",
          name: "Quota",
          resultType: "quota",
          percentRemaining: -25,
          right: "125/100",
        },
      ],
    });
    expect(mapped.entries[0]).toMatchObject({ kind: "value", value: "$12.50" });
    expect(mapped.accounting?.rows[0].value).toMatchObject({ kind: "status", status: "unknown" });
    expect(mapped.entries[1]).toMatchObject({ percentRemaining: -25 });
    expect(() =>
      mapRemoteQuotaResponse(def, { version: "quota-v1", entries: [], secret: "private" }),
    ).toThrow();
  });
});
