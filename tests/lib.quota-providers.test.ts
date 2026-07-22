import { describe, expect, it } from "vitest";

import {
  QUOTA_PROVIDER_MODES,
  QUOTA_PROVIDER_REMOTE_FORMATS,
  cloneQuotaProviders,
  normalizeJsonV1Timestamp,
  validateQuotaProviders,
} from "../src/lib/quota-providers.js";
import {
  listModelsForProvider,
  listProviders,
  listProvidersForModelId,
} from "../src/lib/modelsdev-pricing.js";
import {
  localQuotaProvider,
  quotaProvider,
  VALID_QUOTA_PROVIDER_INPUTS,
  VALID_QUOTA_PROVIDERS,
} from "./fixtures/quota-providers.js";

describe("quotaProviders schema", () => {
  it("accepts and normalizes the exact ordered remote schema", () => {
    expect(QUOTA_PROVIDER_MODES).toEqual(["remote-api", "local-estimate"]);
    expect(QUOTA_PROVIDER_REMOTE_FORMATS).toEqual(["quota-v1", "openrouter-key-v1", "json-v1"]);

    const result = validateQuotaProviders(VALID_QUOTA_PROVIDER_INPUTS);
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual(VALID_QUOTA_PROVIDERS);
    expect(result.value?.map((definition) => definition.id)).toEqual([
      "openrouter-primary",
      "internal-accounting",
    ]);
  });

  it("defaults providerId and label from stable id and clones nested values", () => {
    const result = validateQuotaProviders([
      localQuotaProvider({
        modelIds: ["model-a"],
        windows: [
          {
            id: "daily",
            label: "Daily",
            type: "utc-day",
            requestLimit: 100,
            usdBudget: 10,
          },
        ],
      }),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.value?.[0]).toMatchObject({
      id: "local-provider",
      providerId: "local-provider",
      label: "Local Provider",
      mode: "local-estimate",
    });

    const cloned = cloneQuotaProviders(result.value!);
    expect(cloned).toEqual(result.value);
    expect(cloned).not.toBe(result.value);
    expect(cloned[0]).not.toBe(result.value?.[0]);
    if (cloned[0]?.mode === "local-estimate" && result.value?.[0]?.mode === "local-estimate") {
      expect(cloned[0].windows).not.toBe(result.value[0].windows);
    }
  });

  it("rejects unknown fields, missing fields, unsupported modes, and duplicate ids atomically", () => {
    const result = validateQuotaProviders([
      null,
      {
        id: "same",
        mode: "remote-api",
        executableMapping: "no",
      },
      quotaProvider({ id: "same" }),
    ]);

    expect(result.value).toBeUndefined();
    expect(result.issues.map((issue) => issue.key)).toEqual(
      expect.arrayContaining([
        "quotaProviders[0]",
        "quotaProviders[1].executableMapping",
        "quotaProviders[1].url",
        "quotaProviders[1].format",
        "quotaProviders[2].id",
      ]),
    );
  });

  it("requires providerId to be omitted when it equals id", () => {
    expect(
      validateQuotaProviders([quotaProvider({ providerId: "provider-one" })]).issues,
    ).toContainEqual({
      key: "quotaProviders[0].providerId",
      message: "omit providerId when it is the same as id",
    });
  });

  it("enforces stable id grammar, length, and reserved provider collisions", () => {
    const validId = "a" + "b".repeat(63);
    expect(validateQuotaProviders([quotaProvider({ id: validId })]).issues).toEqual([]);

    for (const id of ["Uppercase", "bad_id", "1leading", "a" + "b".repeat(64)]) {
      expect(validateQuotaProviders([quotaProvider({ id })]).issues[0]?.key).toBe(
        "quotaProviders[0].id",
      );
    }

    for (const id of ["quota-providers", "openai"]) {
      expect(validateQuotaProviders([quotaProvider({ id })]).issues).toContainEqual(
        expect.objectContaining({ key: "quotaProviders[0].id" }),
      );
    }
  });

  it("enforces the exact providerId grammar and 64-character limit", () => {
    expect(
      validateQuotaProviders([quotaProvider({ providerId: "provider.one_two-3" })]).issues,
    ).toEqual([]);

    for (const providerId of ["Provider", "provider id", "p".repeat(65)]) {
      expect(validateQuotaProviders([quotaProvider({ providerId })]).issues[0]?.key).toBe(
        "quotaProviders[0].providerId",
      );
    }
  });

  it("trims printable Unicode labels, permits duplicates, and enforces 80 code points", () => {
    const accepted = validateQuotaProviders([
      quotaProvider({ id: "one", label: "  Café 🚀  " }),
      quotaProvider({
        id: "two",
        label: "Café 🚀",
        url: "https://two.example/accounting",
      }),
    ]);
    expect(accepted.issues).toEqual([]);
    expect(accepted.value?.map((definition) => definition.label)).toEqual(["Café 🚀", "Café 🚀"]);

    for (const label of ["x".repeat(81), "line\nbreak"]) {
      expect(validateQuotaProviders([quotaProvider({ label })]).issues[0]?.key).toBe(
        "quotaProviders[0].label",
      );
    }
  });

  it("enforces the exact apiKeyEnv grammar and 128-character limit", () => {
    const maxLengthName = "A" + "B".repeat(127);
    expect(validateQuotaProviders([quotaProvider({ apiKeyEnv: maxLengthName })]).issues).toEqual(
      [],
    );

    for (const apiKeyEnv of ["lowercase_key", "A" + "B".repeat(128)]) {
      expect(validateQuotaProviders([quotaProvider({ apiKeyEnv })]).issues[0]?.key).toBe(
        "quotaProviders[0].apiKeyEnv",
      );
    }
  });

  it("rejects duplicate remote request identity but keeps format and credential identity explicit", () => {
    const duplicate = validateQuotaProviders([
      quotaProvider({
        id: "one",
        providerId: "shared",
        modelIds: ["model-a"],
      }),
      quotaProvider({
        id: "two",
        providerId: "shared",
        label: "Different label",
        modelIds: ["model-b"],
      }),
    ]);
    expect(duplicate.issues).toContainEqual({
      key: "quotaProviders[1].url",
      message: "duplicates request identity from quotaProviders[0]",
    });

    expect(
      validateQuotaProviders([
        quotaProvider({
          id: "one",
          providerId: "shared",
          modelIds: ["model-a"],
        }),
        quotaProvider({
          id: "two",
          providerId: "shared",
          modelIds: ["model-b"],
          format: "openrouter-key-v1",
        }),
        quotaProvider({
          id: "three",
          providerId: "shared",
          modelIds: ["model-c"],
          apiKeyEnv: "OTHER_KEY",
        }),
      ]).issues,
    ).toEqual([]);
  });

  it("preserves disjoint model order and rejects provider-wide overlap", () => {
    const disjoint = validateQuotaProviders([
      quotaProvider({
        id: "one",
        providerId: "shared",
        modelIds: ["model-b", "model-a"],
      }),
      quotaProvider({
        id: "two",
        providerId: "shared",
        url: "https://two.example/accounting",
        modelIds: ["model-c"],
      }),
    ]);
    expect(disjoint.issues).toEqual([]);
    expect(disjoint.value?.[0]?.modelIds).toEqual(["model-b", "model-a"]);

    expect(
      validateQuotaProviders([
        quotaProvider({ id: "wide", providerId: "shared" }),
        quotaProvider({
          id: "narrow",
          providerId: "shared",
          url: "https://narrow.example/accounting",
          modelIds: ["model-a"],
        }),
      ]).issues,
    ).toContainEqual(
      expect.objectContaining({
        key: "quotaProviders[1].modelIds",
        message: expect.stringContaining("overlaps"),
      }),
    );
  });

  it("allows HTTPS and loopback HTTP but rejects non-loopback HTTP, credentials, queries, and fragments", () => {
    for (const url of [
      "https://provider.example/accounting",
      "http://localhost:8787/accounting",
      "http://127.0.0.1:8787/accounting",
      "http://[::1]:8787/accounting",
    ]) {
      expect(validateQuotaProviders([quotaProvider({ url })]).issues).toEqual([]);
    }

    for (const url of [
      "http://provider.example/accounting",
      "https://user:pass@provider.example/accounting",
      "https://provider.example/accounting?secret=x",
      "https://provider.example/accounting#fragment",
    ]) {
      expect(validateQuotaProviders([quotaProvider({ url })]).issues[0]?.key).toBe(
        "quotaProviders[0].url",
      );
    }
  });

  it("validates exact model selectors and overlapping provider coverage", () => {
    const result = validateQuotaProviders([
      quotaProvider({ id: "one", providerId: "shared", modelIds: ["model-a"] }),
      quotaProvider({
        id: "two",
        providerId: "shared",
        url: "https://two.example/accounting",
        modelIds: ["model-a"],
      }),
    ]);
    expect(result.issues).toContainEqual({
      key: "quotaProviders[1].modelIds",
      message: 'provider/model coverage overlaps quotaProviders[0] for providerId "shared"',
    });
    expect(
      validateQuotaProviders([quotaProvider({ modelIds: ["model with spaces"] })]).issues[0]?.key,
    ).toBe("quotaProviders[0].modelIds[0]");
  });

  it("accepts bounded UTC-day and rolling request/budget windows", () => {
    const result = validateQuotaProviders([
      localQuotaProvider({
        windows: [
          { id: "daily", type: "utc-day", requestLimit: 100, usdBudget: 5 },
          {
            id: "five-hour",
            label: "5h",
            type: "rolling",
            durationMinutes: 300,
            requestLimit: 25,
          },
        ],
      }),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.value?.[0]).toMatchObject({
      mode: "local-estimate",
      windows: [
        { id: "daily", label: "daily", type: "utc-day", requestLimit: 100 },
        {
          id: "five-hour",
          label: "5h",
          type: "rolling",
          durationMinutes: 300,
          requestLimit: 25,
        },
      ],
    });
  });

  it("rejects invalid or unbounded local windows", () => {
    const result = validateQuotaProviders([
      localQuotaProvider({
        windows: [
          { id: "daily", type: "utc-day", durationMinutes: 60, requestLimit: 0 },
          { id: "rolling", type: "rolling", durationMinutes: 0, requestLimit: 10 },
        ],
      }),
    ]);
    expect(result.issues.map((issue) => issue.key)).toEqual(
      expect.arrayContaining([
        "quotaProviders[0].windows[0].durationMinutes",
        "quotaProviders[0].windows[0].requestLimit",
        "quotaProviders[0].windows[1].durationMinutes",
      ]),
    );
  });

  it("never allows pricingModelMap to override a successful automatic match", () => {
    expect(
      validateQuotaProviders([
        localQuotaProvider({
          id: "openai",
          windows: [{ id: "daily", type: "utc-day", requestLimit: 10 }],
          pricingModelMap: { "gpt-4o": "openai/gpt-4o" },
        }),
      ]).issues,
    ).toContainEqual(
      expect.objectContaining({
        key: "quotaProviders[0].pricingModelMap.gpt-4o",
        message: expect.stringContaining("automatic models.dev matching already resolves"),
      }),
    );
  });

  it("allows a manual priced fallback when automatic matching is missing or ambiguous", () => {
    const providers = listProviders();
    const pricedTargetProvider = providers.find(
      (provider) => listModelsForProvider(provider).length > 0,
    )!;
    const pricedTargetModel = listModelsForProvider(pricedTargetProvider)[0]!;
    const ambiguousModel = providers
      .flatMap((provider) => listModelsForProvider(provider))
      .find((model) => listProvidersForModelId(model).length > 1);
    const sourceModel = ambiguousModel ?? "private-model-without-modelsdev-match";

    const result = validateQuotaProviders([
      localQuotaProvider({
        providerId: "private-gateway",
        pricingModelMap: {
          [sourceModel]: pricedTargetProvider + "/" + pricedTargetModel,
        },
      }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it("accepts the deprecated raw alias but immediately normalizes it to quota-v1", () => {
    const result = validateQuotaProviders([quotaProvider({ format: "accounting-v1" })]);

    expect(result.issues).toEqual([]);
    expect(result.value?.[0]).toMatchObject({ format: "quota-v1" });
    expect(JSON.stringify(result.value)).not.toContain("accounting-v1");
  });

  it("uses canonical format when detecting duplicate request identity", () => {
    const result = validateQuotaProviders([
      quotaProvider({
        id: "one",
        providerId: "shared",
        modelIds: ["model-a"],
        format: "quota-v1",
      }),
      quotaProvider({
        id: "two",
        providerId: "shared",
        modelIds: ["model-b"],
        format: "accounting-v1",
      }),
    ]);

    expect(result.issues).toContainEqual({
      key: "quotaProviders[1].url",
      message: "duplicates request identity from quotaProviders[0]",
    });
  });

  it("validates, normalizes, and deeply clones a tagged json-v1 adapter", () => {
    const raw = quotaProvider({
      format: "json-v1",
      adapter: {
        rowsPath: ["data", "plans"],
        mappings: [
          {
            resultType: "quota",
            name: " Tokens ",
            label: " Used: ",
            unit: " tokens ",
            unitPosition: "suffix",
            resetTime: { path: ["reset_at"], encoding: "iso-8601" },
            observedTime: { literal: 1_784_678_400, encoding: "unix-seconds" },
            metric: {
              type: "used-limit",
              used: { path: ["used"], divideBy: 100 },
              limit: { literal: 10 },
            },
          },
        ],
      },
    });
    const result = validateQuotaProviders([raw]);

    expect(result.issues).toEqual([]);
    expect(result.value?.[0]).toMatchObject({
      format: "json-v1",
      adapter: {
        rowsPath: ["data", "plans"],
        mappings: [
          {
            name: "Tokens",
            label: "Used:",
            unit: "tokens",
            metric: { type: "used-limit" },
          },
        ],
      },
    });

    const normalized = result.value?.[0];
    expect(normalized?.mode).toBe("remote-api");
    if (normalized?.mode === "remote-api" && normalized.format === "json-v1") {
      const cloned = cloneQuotaProviders([normalized])[0]!;
      expect(cloned).not.toBe(normalized);
      if (cloned.mode === "remote-api" && cloned.format === "json-v1") {
        expect(cloned.adapter).not.toBe(normalized.adapter);
        expect(cloned.adapter.mappings[0]?.metric).not.toBe(normalized.adapter.mappings[0]?.metric);
      }
    }
  });

  it.each([
    {
      name: "missing adapter",
      definition: quotaProvider({ format: "json-v1" }),
      key: "quotaProviders[0].adapter",
    },
    {
      name: "adapter on canonical envelope",
      definition: quotaProvider({ adapter: { mappings: [] } }),
      key: "quotaProviders[0].adapter",
    },
    {
      name: "forbidden path segment",
      definition: quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "usage",
              name: "Usage",
              metric: {
                type: "value",
                valueType: "used",
                value: { path: ["__proto__"] },
              },
            },
          ],
        },
      }),
      key: "quotaProviders[0].adapter.mappings[0].metric.value.path[0]",
    },
    {
      name: "unknown nested field",
      definition: quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "usage",
              name: "Usage",
              metric: {
                type: "value",
                valueType: "used",
                value: { literal: 1 },
                attackerControlledName: "must-not-echo",
              },
            },
          ],
        },
      }),
      key: "quotaProviders[0].adapter.mappings[0].metric.*",
    },
    {
      name: "incompatible result type",
      definition: quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "status",
              name: "Usage",
              metric: { type: "value", valueType: "used", value: { literal: 1 } },
            },
          ],
        },
      }),
      key: "quotaProviders[0].adapter.mappings[0].metric.valueType",
    },
    {
      name: "invalid literal timestamp",
      definition: quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "status",
              name: "Status",
              resetTime: { literal: "2026-02-30T00:00:00Z", encoding: "iso-8601" },
              metric: { type: "status", value: { literal: "Ready" } },
            },
          ],
        },
      }),
      key: "quotaProviders[0].adapter.mappings[0].resetTime.literal",
    },
    {
      name: "too many mappings",
      definition: quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: Array.from({ length: 17 }, () => ({
            resultType: "usage",
            name: "Usage",
            metric: { type: "value", valueType: "used", value: { literal: 1 } },
          })),
        },
      }),
      key: "quotaProviders[0].adapter.mappings",
    },
  ])("rejects bounded json-v1 configuration: $name", ({ definition, key }) => {
    const result = validateQuotaProviders([definition]);
    expect(result.value).toBeUndefined();
    expect(result.issues).toContainEqual(expect.objectContaining({ key }));
    expect(JSON.stringify(result.issues)).not.toContain("must-not-echo");
    expect(JSON.stringify(result.issues)).not.toContain("attackerControlledName");
  });

  it("accepts exact json-v1 path, mapping, static text, unit, and numeric boundaries", () => {
    const longSegment = "路径".repeat(32);
    const result = validateQuotaProviders([
      quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: Array.from({ length: 16 }, (_, index) => ({
            resultType: "usage",
            name: "n".repeat(80),
            unit: "u".repeat(32),
            unitPosition: "suffix",
            metric: {
              type: "value",
              valueType: "used",
              value:
                index === 0
                  ? { path: Array.from({ length: 8 }, () => longSegment) }
                  : { literal: 1e15 },
            },
          })),
        },
      }),
    ]);

    expect(result.issues).toEqual([]);
  });

  it("accepts the maximum valid json-v1 schema shape within every structural bound", () => {
    const path = () => Array.from({ length: 8 }, () => "p".repeat(64));
    const result = validateQuotaProviders([
      quotaProvider({
        format: "json-v1",
        adapter: {
          rowsPath: path(),
          mappings: Array.from({ length: 16 }, () => ({
            resultType: "quota",
            name: "n".repeat(80),
            label: "l".repeat(80),
            unit: "u".repeat(32),
            unitPosition: "suffix",
            resetTime: { path: path(), encoding: "iso-8601" },
            observedTime: { path: path(), encoding: "unix-milliseconds" },
            metric: {
              type: "remaining-limit",
              remaining: { path: path(), divideBy: 100 },
              limit: { path: path(), divideBy: 1_000_000 },
            },
          })),
        },
      }),
    ]);

    expect(result.issues).toEqual([]);
  });

  it.each([
    {
      name: "81-code-point name",
      mapping: {
        resultType: "usage",
        name: "n".repeat(81),
        metric: { type: "value", valueType: "used", value: { literal: 1 } },
      },
      key: "quotaProviders[0].adapter.mappings[0].name",
    },
    {
      name: "81-code-point label",
      mapping: {
        resultType: "usage",
        name: "Usage",
        label: "l".repeat(81),
        metric: { type: "value", valueType: "used", value: { literal: 1 } },
      },
      key: "quotaProviders[0].adapter.mappings[0].label",
    },
    {
      name: "33-code-point unit",
      mapping: {
        resultType: "usage",
        name: "Usage",
        unit: "u".repeat(33),
        unitPosition: "suffix",
        metric: { type: "value", valueType: "used", value: { literal: 1 } },
      },
      key: "quotaProviders[0].adapter.mappings[0].unit",
    },
  ])("rejects json-v1 static field bounds: $name", ({ mapping, key }) => {
    const result = validateQuotaProviders([
      quotaProvider({
        format: "json-v1",
        adapter: { mappings: [mapping] },
      }),
    ]);

    expect(result.issues).toContainEqual(expect.objectContaining({ key }));
  });

  it.each([
    ["Cc", "\u0007"],
    ["Cf", "\u202e"],
    ["Zl", "\u2028"],
    ["Zp", "\u2029"],
  ])(
    "rejects Unicode %s characters in every json-v1 static display field",
    (_category, character) => {
      const cases = [
        {
          mapping: {
            resultType: "usage",
            name: `Us${character}age`,
            metric: { type: "value", valueType: "used", value: { literal: 1 } },
          },
          key: "quotaProviders[0].adapter.mappings[0].name",
        },
        {
          mapping: {
            resultType: "usage",
            name: "Usage",
            label: `Us${character}ed:`,
            metric: { type: "value", valueType: "used", value: { literal: 1 } },
          },
          key: "quotaProviders[0].adapter.mappings[0].label",
        },
        {
          mapping: {
            resultType: "usage",
            name: "Usage",
            unit: `to${character}kens`,
            unitPosition: "suffix",
            metric: { type: "value", valueType: "used", value: { literal: 1 } },
          },
          key: "quotaProviders[0].adapter.mappings[0].unit",
        },
        {
          mapping: {
            resultType: "status",
            name: "Status",
            metric: { type: "status", value: { literal: `Re${character}ady` } },
          },
          key: "quotaProviders[0].adapter.mappings[0].metric.value.literal",
        },
      ];

      for (const item of cases) {
        const result = validateQuotaProviders([
          quotaProvider({
            format: "json-v1",
            adapter: { mappings: [item.mapping] },
          }),
        ]);

        expect(result.value).toBeUndefined();
        expect(result.issues).toContainEqual(expect.objectContaining({ key: item.key }));
      }
    },
  );

  it("rejects a provider-prefixed json-v1 entry name above 160 code points", () => {
    const result = validateQuotaProviders([
      quotaProvider({
        label: "p".repeat(80),
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "usage",
              name: "n".repeat(80),
              metric: { type: "value", valueType: "used", value: { literal: 1 } },
            },
          ],
        },
      }),
    ]);

    expect(result.issues).toContainEqual({
      key: "quotaProviders[0].adapter.mappings[0].name",
      message: "provider-prefixed name must not exceed 160 code points",
    });
  });

  it.each([
    {
      name: "nine path segments",
      value: { path: Array.from({ length: 9 }, () => "segment") },
      key: "quotaProviders[0].adapter.mappings[0].metric.value.path",
    },
    {
      name: "65-code-point path segment",
      value: { path: ["x".repeat(65)] },
      key: "quotaProviders[0].adapter.mappings[0].metric.value.path[0]",
    },
    {
      name: "number above magnitude",
      value: { literal: 1e15 + 1 },
      key: "quotaProviders[0].adapter.mappings[0].metric.value.literal",
    },
  ])("rejects json-v1 scalar bounds: $name", ({ value, key }) => {
    const result = validateQuotaProviders([
      quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "usage",
              name: "Usage",
              metric: { type: "value", valueType: "used", value },
            },
          ],
        },
      }),
    ]);
    expect(result.issues).toContainEqual(expect.objectContaining({ key }));
  });

  it.each([
    {
      name: "object count",
      padding: Array.from({ length: 128 }, () => ({})),
      message: "must not exceed 128 objects",
    },
    {
      name: "property count",
      padding: Object.fromEntries(
        Array.from({ length: 380 }, (_, index) => [`field${index}`, index]),
      ),
      message: "must not exceed 384 object properties",
    },
    {
      name: "array element count",
      padding: Array.from({ length: 640 }, () => 0),
      message: "must not exceed 640 total array elements",
    },
  ])("rejects json-v1 adapter structural $name", ({ padding, message }) => {
    const result = validateQuotaProviders([
      quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "usage",
              name: "Usage",
              metric: { type: "value", valueType: "used", value: { literal: 1 } },
            },
          ],
          padding,
        },
      }),
    ]);
    expect(result.issues).toContainEqual({
      key: "quotaProviders[0].adapter",
      message,
    });
  });

  it("rejects adapter structures deeper than eight container levels", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 9; index += 1) nested = { nested };
    const result = validateQuotaProviders([
      quotaProvider({
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "usage",
              name: "Usage",
              metric: { type: "value", valueType: "used", value: { literal: 1 } },
              extra: nested,
            },
          ],
        },
      }),
    ]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ key: "quotaProviders[0].adapter" }),
    );
  });

  it("normalizes exact json-v1 timestamp encodings and rejects invalid ranges", () => {
    expect(normalizeJsonV1Timestamp("2026-07-22T03:34:43.1+02:00", "iso-8601")).toBe(
      "2026-07-22T01:34:43.100Z",
    );
    expect(normalizeJsonV1Timestamp("2000-02-29T14:00:00+14:00", "iso-8601")).toBe(
      "2000-02-29T00:00:00.000Z",
    );
    expect(normalizeJsonV1Timestamp("9999-12-31T23:59:59.999Z", "iso-8601")).toBe(
      "9999-12-31T23:59:59.999Z",
    );
    expect(normalizeJsonV1Timestamp(0, "unix-seconds")).toBe("1970-01-01T00:00:00.000Z");
    expect(normalizeJsonV1Timestamp(253_402_300_799, "unix-seconds")).toBe(
      "9999-12-31T23:59:59.000Z",
    );
    expect(normalizeJsonV1Timestamp(253_402_300_799_999, "unix-milliseconds")).toBe(
      "9999-12-31T23:59:59.999Z",
    );
    for (const value of [
      "1900-02-29T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-01-01T00:00:00.0000Z",
      "2026-01-01T00:00:00+14:01",
      "1969-12-31T23:59:59Z",
    ]) {
      expect(normalizeJsonV1Timestamp(value, "iso-8601")).toBeNull();
    }
    expect(normalizeJsonV1Timestamp(-1, "unix-milliseconds")).toBeNull();
    expect(normalizeJsonV1Timestamp(1.5, "unix-seconds")).toBeNull();
    expect(normalizeJsonV1Timestamp(253_402_300_800, "unix-seconds")).toBeNull();
    expect(normalizeJsonV1Timestamp(253_402_300_800_000, "unix-milliseconds")).toBeNull();
  });

  it("accepts only the exact maintained Qwen and Alibaba tuning windows", () => {
    expect(
      validateQuotaProviders([
        {
          id: "qwen-code",
          mode: "local-estimate",
          windows: [
            { id: "daily", type: "utc-day", requestLimit: 2000 },
            { id: "rpm", type: "rolling", durationMinutes: 1, requestLimit: 120 },
          ],
        },
      ]).issues,
    ).toEqual([]);

    expect(
      validateQuotaProviders([
        {
          id: "alibaba-coding-plan",
          mode: "local-estimate",
          windows: [
            { id: "five-hour", type: "rolling", durationMinutes: 300, requestLimit: 2000 },
            { id: "weekly", type: "rolling", durationMinutes: 10080, requestLimit: 10000 },
            { id: "monthly", type: "rolling", durationMinutes: 43200, requestLimit: 20000 },
          ],
        },
      ]).issues,
    ).toEqual([]);

    expect(
      validateQuotaProviders([
        {
          id: "qwen-code",
          mode: "local-estimate",
          windows: [{ id: "daily", type: "utc-day", requestLimit: 2000 }],
        },
      ]).issues[0]?.key,
    ).toBe("quotaProviders[0].windows");
  });
});
