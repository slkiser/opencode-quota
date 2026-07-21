import { describe, expect, it } from "vitest";

import {
  QUOTA_PROVIDER_MODES,
  QUOTA_PROVIDER_REMOTE_FORMATS,
  cloneQuotaProviders,
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
    expect(QUOTA_PROVIDER_REMOTE_FORMATS).toEqual(["accounting-v1", "openrouter-key-v1"]);

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
