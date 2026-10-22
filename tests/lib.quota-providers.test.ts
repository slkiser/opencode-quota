import { describe, expect, it, vi } from "vite-plus/test";
import { listProvidersForModelId } from "../src/lib/modelsdev-pricing.js";
import {
  cloneQuotaProviders,
  customQuotaProviderDefinitions,
  describeQuotaProviderRequest,
  normalizeJsonV1Timestamp,
  QUOTA_PROVIDER_MODES,
  QUOTA_PROVIDER_REMOTE_FORMATS,
  selectEligibleQuotaProviderDefinitions,
  validateQuotaProviders,
} from "../src/lib/quota-providers.js";
import {
  localQuotaProvider,
  quotaProvider,
  VALID_QUOTA_PROVIDER_INPUTS,
  VALID_QUOTA_PROVIDERS,
} from "./fixtures/quota-providers.js";
import { SHIPPED_PRICE_LIST } from "./helpers/shipped-price-list.js";

const M0 = "quotaProviders[0].adapter.mappings[0]";

/** A json-v1 mapping that reports usage; `fields` replace or add to its defaults. */
function usage(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resultType: "usage",
    name: "Usage",
    metric: { type: "value", valueType: "used", value: { literal: 1 } },
    ...fields,
  };
}

/** A usage mapping whose used value is read from `value`. */
function usedFrom(value: unknown): Record<string, unknown> {
  return usage({ metric: { type: "value", valueType: "used", value } });
}

/** A remote definition whose json-v1 adapter has these mappings. */
function jsonV1(...mappings: unknown[]): Record<string, unknown> {
  return quotaProvider({ format: "json-v1", adapter: { mappings } });
}

/** `levels` objects nested inside each other. */
function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let index = 0; index < levels; index += 1) value = { nested: value };
  return value;
}

/** The longest json-v1 name, 80 code points, different for each index: two names may not give one row id. */
function maxName(index: number): string {
  return `${String(index).padStart(2, "0")}${"n".repeat(78)}`;
}

describe("quotaProviders schema", () => {
  it("keeps provider-wide definitions context-sensitive when no current model is selected", () => {
    const definitions = [quotaProvider({ id: "provider-wide", providerId: "provider-one" })];
    const availableProviderIds = new Set(["provider-one"]);

    expect(
      selectEligibleQuotaProviderDefinitions({
        definitions,
        availableProviderIds,
        onlyCurrentModel: true,
      }),
    ).toEqual([]);
    expect(
      selectEligibleQuotaProviderDefinitions({
        definitions,
        availableProviderIds,
        onlyCurrentModel: false,
      }).map((definition) => definition.id),
    ).toEqual(["provider-wide"]);
  });

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
        "quotaProviders[1]",
        "quotaProviders[1].url",
        "quotaProviders[1].format",
        "quotaProviders[2].id",
      ]),
    );
  });

  it("passes its own output again unchanged, providerId included", () => {
    const inputs = [
      ...VALID_QUOTA_PROVIDER_INPUTS,
      quotaProvider({ id: "same-provider", format: "accounting-v1", label: "  Same  " }),
      {
        ...jsonV1(
          usage({ resultType: "rate_limit", resetTime: { literal: 0, encoding: "unix-seconds" } }),
        ),
        id: "json-one",
        providerId: "json-provider",
      },
      localQuotaProvider({ id: "local-one", providerId: "local-provider" }),
    ];
    const first = validateQuotaProviders(inputs);
    expect(first.issues).toEqual([]);

    const second = validateQuotaProviders(first.value);
    expect(second.issues).toEqual([]);
    expect(second.value).toEqual(first.value);
  });

  it.each([
    [
      "id",
      "a" + "b".repeat(63),
      ["Uppercase", "bad_id", "1leading", "a" + "b".repeat(64), "quota-providers", "openai"],
    ],
    ["providerId", "provider.one_two-3", ["Provider", "provider id", "p".repeat(65)]],
    ["label", "x".repeat(80), ["x".repeat(81), "line\nbreak"]],
    ["apiKeyEnv", "A" + "B".repeat(127), ["lowercase_key", "A" + "B".repeat(128)]],
  ])("enforces the %s grammar, length limit and reserved values", (field, valid, invalid) => {
    expect(validateQuotaProviders([quotaProvider({ [field]: valid })]).issues).toEqual([]);
    for (const value of invalid) {
      expect(validateQuotaProviders([quotaProvider({ [field]: value })]).issues[0]?.key).toBe(
        `quotaProviders[0].${field}`,
      );
    }
  });

  // Built-in providers of 4.x and 5.x that this version does not have.
  it.each(["chutes", "kilo", "nanogpt", "nano-gpt", "synthetic"])(
    "accepts a custom provider with the id %s",
    (id) => {
      const accepted = validateQuotaProviders([quotaProvider({ id })]);

      expect(accepted.issues).toEqual([]);
      expect(accepted.value?.[0]).toMatchObject({ id, providerId: id });
    },
  );

  // v6 retired this id's maintained estimate; a leftover tuning must not void other definitions.
  it("ignores a leftover tuning of the retired maintained estimate", () => {
    const leftover = localQuotaProvider({ id: "alibaba-coding-plan" });
    const other = quotaProvider({ id: "other-provider" });

    const accepted = validateQuotaProviders([leftover, other]);

    expect(accepted.issues).toEqual([]);
    expect(accepted.value?.map((definition) => definition.id)).toEqual([
      "alibaba-coding-plan",
      "other-provider",
    ]);
    // It tunes nothing now, so it never runs: the built-in of that id reads the official CLI.
    expect(
      customQuotaProviderDefinitions(accepted.value ?? []).map((definition) => definition.id),
    ).toEqual(["other-provider"]);
  });

  it("still rejects the retired estimate's id in the shape a new definition takes", () => {
    const result = validateQuotaProviders([quotaProvider({ id: "alibaba-coding-plan" })]);

    expect(result.issues).toContainEqual({
      key: "quotaProviders[0].id",
      message: 'collides with built-in quota provider id "alibaba-coding-plan"',
    });
  });

  it("trims printable Unicode labels and permits duplicates", () => {
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
  });

  it("rejects duplicate canonical request identity but keeps format and credential identity explicit", () => {
    const duplicate = validateQuotaProviders([
      quotaProvider({
        id: "one",
        providerId: "shared",
        modelIds: ["model-a"],
        format: "quota-v1",
      }),
      quotaProvider({
        id: "two",
        providerId: "shared",
        label: "Different label",
        modelIds: ["model-b"],
        // The deprecated alias of quota-v1.
        format: "accounting-v1",
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

  it("preserves disjoint model order and validates exact model selectors", () => {
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
      validateQuotaProviders([quotaProvider({ modelIds: ["model with spaces"] })]).issues[0]?.key,
    ).toBe("quotaProviders[0].modelIds[0]");
  });

  it.each([
    ["provider-wide and model-specific", {}, { modelIds: ["model-a"] }],
    ["the same model", { modelIds: ["model-a"] }, { modelIds: ["model-a"] }],
  ])("rejects %s coverage of one providerId", (_name, first, second) => {
    const result = validateQuotaProviders([
      quotaProvider({ id: "one", providerId: "shared", ...first }),
      quotaProvider({
        id: "two",
        providerId: "shared",
        url: "https://two.example/accounting",
        ...second,
      }),
    ]);
    expect(result.issues).toContainEqual({
      key: "quotaProviders[1].modelIds",
      message: 'provider/model coverage overlaps quotaProviders[0] for providerId "shared"',
    });
  });

  it.each([
    ["https://provider.example/accounting", false],
    ["http://localhost:8787/accounting", false],
    ["http://127.0.0.1/accounting", false],
    ["http://127.0.0.1:8787/accounting", false],
    ["http://[::1]:8787/accounting", false],
    ["http://127.0.0.2/accounting", true],
    ["http://quota.localhost/accounting", true],
  ])("accepts %s and flags plain HTTP off this computer as insecure=%s", (url, insecure) => {
    const result = validateQuotaProviders([quotaProvider({ url })]);
    expect(result.issues).toEqual([]);
    expect(result.value?.map(describeQuotaProviderRequest)).toEqual([
      expect.objectContaining({ url, insecure }),
    ]);
  });

  it("rejects non-loopback HTTP, credentials, queries, and fragments in a URL", () => {
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
        key: "quotaProviders[0].pricingModelMap",
        message: expect.stringMatching(/^entry 1: automatic models.dev matching already resolves/),
      }),
    );
  });

  it("allows a manual priced fallback when automatic matching is missing or ambiguous", () => {
    const shipped = Object.entries(SHIPPED_PRICE_LIST.providers);
    const [pricedTargetProvider, models] = shipped.find(
      ([, models]) => Object.keys(models).length > 0,
    )!;
    const pricedTargetModel = Object.keys(models)[0]!;
    const ambiguousModel = shipped
      .flatMap(([, models]) => Object.keys(models))
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
    ["missing adapter", quotaProvider({ format: "json-v1" }), "quotaProviders[0].adapter"],
    [
      "adapter on canonical envelope",
      quotaProvider({ adapter: { mappings: [] } }),
      "quotaProviders[0].adapter",
    ],
    [
      "forbidden path segment",
      jsonV1(usedFrom({ path: ["__proto__"] })),
      `${M0}.metric.value.path[0]`,
    ],
    [
      "unknown nested field",
      jsonV1(
        usage({
          metric: {
            type: "value",
            valueType: "used",
            value: { literal: 1 },
            attackerControlledName: "must-not-echo",
          },
        }),
      ),
      `${M0}.metric.*`,
    ],
    ["incompatible result type", jsonV1(usage({ resultType: "status" })), `${M0}.metric.valueType`],
    [
      "invalid literal timestamp",
      jsonV1({
        resultType: "status",
        name: "Status",
        resetTime: { literal: "2026-02-30T00:00:00Z", encoding: "iso-8601" },
        metric: { type: "status", value: { literal: "Ready" } },
      }),
      `${M0}.resetTime.literal`,
    ],
    [
      "too many mappings",
      jsonV1(...Array.from({ length: 17 }, () => usage())),
      "quotaProviders[0].adapter.mappings",
    ],
    ["81-code-point name", jsonV1(usage({ name: "n".repeat(81) })), `${M0}.name`],
    ["81-code-point label", jsonV1(usage({ label: "l".repeat(81) })), `${M0}.label`],
    [
      "33-code-point unit",
      jsonV1(usage({ unit: "u".repeat(33), unitPosition: "suffix" })),
      `${M0}.unit`,
    ],
    [
      "nine path segments",
      jsonV1(usedFrom({ path: Array.from({ length: 9 }, () => "segment") })),
      `${M0}.metric.value.path`,
    ],
    [
      "65-code-point path segment",
      jsonV1(usedFrom({ path: ["x".repeat(65)] })),
      `${M0}.metric.value.path[0]`,
    ],
    [
      "number above magnitude",
      jsonV1(usedFrom({ literal: 1e15 + 1 })),
      `${M0}.metric.value.literal`,
    ],
    [
      "structure deeper than eight container levels",
      jsonV1(usage({ extra: nested(9) })),
      "quotaProviders[0].adapter",
    ],
  ])("rejects bounded json-v1 configuration: %s", (_name, definition, key) => {
    const result = validateQuotaProviders([definition]);
    expect(result.value).toBeUndefined();
    expect(result.issues).toContainEqual(expect.objectContaining({ key }));
    expect(JSON.stringify(result.issues)).not.toContain("must-not-echo");
    expect(JSON.stringify(result.issues)).not.toContain("attackerControlledName");
  });

  const longPath = () => Array.from({ length: 8 }, () => "p".repeat(64));
  it.each([
    [
      "multi-byte paths, number literals and static text",
      jsonV1(
        ...Array.from({ length: 16 }, (_, index) =>
          usage({
            name: maxName(index),
            unit: "u".repeat(32),
            unitPosition: "suffix",
            metric: {
              type: "value",
              valueType: "used",
              value:
                index === 0
                  ? { path: Array.from({ length: 8 }, () => "路径".repeat(32)) }
                  : { literal: 1e15 },
            },
          }),
        ),
      ),
    ],
    [
      "every structural bound",
      quotaProvider({
        format: "json-v1",
        adapter: {
          rowsPath: longPath(),
          mappings: Array.from({ length: 16 }, (_, index) => ({
            resultType: "quota",
            name: maxName(index),
            label: "l".repeat(80),
            unit: "u".repeat(32),
            unitPosition: "suffix",
            resetTime: { path: longPath(), encoding: "iso-8601" },
            observedTime: { path: longPath(), encoding: "unix-milliseconds" },
            metric: {
              type: "remaining-limit",
              remaining: { path: longPath(), divideBy: 100 },
              limit: { path: longPath(), divideBy: 1_000_000 },
            },
          })),
        },
      }),
    ],
  ])("accepts the maximum json-v1 shape with %s", (_name, definition) => {
    expect(validateQuotaProviders([definition]).issues).toEqual([]);
  });

  it("rejects two json-v1 mapping names that would give one row id", () => {
    const result = validateQuotaProviders([
      jsonV1(
        usage({ name: "Daily limit" }),
        usage({ name: "Daily-limit" }),
        usage({ name: "日次" }),
        usage({ name: "Daily_limit" }),
      ),
    ]);

    expect(result.value).toBeUndefined();
    expect(result.issues).toEqual([
      {
        key: "quotaProviders[0].adapter.mappings[3].name",
        message: `gives the same row id as ${M0}.name`,
      },
    ]);
  });

  it.each([
    ["Cc", "\u0007"],
    ["Cf", "‮"],
    ["Zl", " "],
    ["Zp", " "],
  ])(
    "rejects Unicode %s characters in every json-v1 static display field",
    (_category, character) => {
      const cases = [
        [usage({ name: `Us${character}age` }), `${M0}.name`],
        [usage({ label: `Us${character}ed:` }), `${M0}.label`],
        [usage({ unit: `to${character}kens`, unitPosition: "suffix" }), `${M0}.unit`],
        [
          {
            resultType: "status",
            name: "Status",
            metric: { type: "status", value: { literal: `Re${character}ady` } },
          },
          `${M0}.metric.value.literal`,
        ],
      ] as const;

      for (const [mapping, key] of cases) {
        const result = validateQuotaProviders([jsonV1(mapping)]);
        expect(result.value).toBeUndefined();
        expect(result.issues).toContainEqual(expect.objectContaining({ key }));
      }
    },
  );

  it("allows json-v1 names and labels of up to 80 code points", () => {
    const result = validateQuotaProviders([
      { ...jsonV1(usage({ name: "n".repeat(78), label: "😀".repeat(80) })), label: "p".repeat(80) },
    ]);
    expect(result.issues).toEqual([]);

    const tooLong = validateQuotaProviders([
      jsonV1(usage({ name: "n".repeat(81), label: "l".repeat(81) })),
    ]);
    expect(tooLong.issues).toEqual([
      { key: `${M0}.name`, message: "expected 1-80 printable Unicode code points after trimming" },
      { key: `${M0}.label`, message: "expected 1-80 printable Unicode code points after trimming" },
    ]);
  });

  it.each([
    ["object count", Array.from({ length: 128 }, () => ({})), "must not exceed 128 objects"],
    [
      "property count",
      Object.fromEntries(Array.from({ length: 380 }, (_, index) => [`field${index}`, index])),
      "must not exceed 384 object properties",
    ],
    [
      "array element count",
      Array.from({ length: 640 }, () => 0),
      "must not exceed 640 total array elements",
    ],
  ])("rejects json-v1 adapter structural %s", (_name, padding, message) => {
    const result = validateQuotaProviders([
      quotaProvider({ format: "json-v1", adapter: { mappings: [usage()], padding } }),
    ]);
    expect(result.issues).toContainEqual({ key: "quotaProviders[0].adapter", message });
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
});

describe("the enabled field of a custom provider", () => {
  it("is on when missing, keeps false, accepts only true or false, and runs only switched-on providers", () => {
    const result = validateQuotaProviders([
      quotaProvider({ id: "on-gateway" }),
      quotaProvider({ id: "off-gateway", url: "https://off.example/quota", enabled: false }),
      localQuotaProvider({ id: "off-local", enabled: false }),
    ]);
    expect(result.issues).toEqual([]);
    const definitions = result.value ?? [];
    expect(definitions[0]).not.toHaveProperty("enabled");
    expect(definitions.map((definition) => definition.enabled)).toEqual([undefined, false, false]);
    expect(customQuotaProviderDefinitions(definitions)).toEqual([definitions[0]]);

    expect(validateQuotaProviders([quotaProvider({ enabled: "no" })]).issues).toEqual([
      { key: "quotaProviders[0].enabled", message: "expected true or false" },
    ]);
  });

  it("is described by scheme, host, path and key source, never the key", () => {
    vi.stubEnv("OFF_GATEWAY_KEY", "off-key-value");
    const result = validateQuotaProviders([
      quotaProvider({
        id: "off-gateway",
        providerId: "vendor",
        url: "https://off.example/v1/quota",
        apiKeyEnv: "OFF_GATEWAY_KEY",
        enabled: false,
      }),
      quotaProvider({ id: "keyless", providerId: "other", url: "https://keyless.example/quota" }),
      localQuotaProvider({ enabled: false }),
    ]);

    expect(result.value?.map(describeQuotaProviderRequest)).toEqual([
      {
        url: "https://off.example/v1/quota",
        key: "OFF_GATEWAY_KEY, else OpenCode's vendor key",
        insecure: false,
      },
      {
        url: "https://keyless.example/quota",
        key: "OpenCode's other key",
        insecure: false,
      },
      null,
    ]);
  });
});
