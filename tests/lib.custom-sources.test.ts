import { describe, expect, it } from "vitest";
import {
  CUSTOM_SOURCE_PRESETS,
  cloneCustomSources,
  validateCustomSources,
} from "../src/lib/custom-sources.js";
import {
  customSource,
  VALID_CUSTOM_SOURCE_INPUTS,
  VALID_CUSTOM_SOURCES,
} from "./fixtures/custom-sources.js";

describe("custom source schema", () => {
  it("accepts only the two initial presets, normalizes labels, and preserves order", () => {
    expect(CUSTOM_SOURCE_PRESETS).toEqual(["accounting-v1", "openrouter-key-v1"]);

    const result = validateCustomSources(VALID_CUSTOM_SOURCE_INPUTS);
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual(VALID_CUSTOM_SOURCES);
    expect(result.value?.map((source) => source.id)).toEqual([
      "openrouter-primary",
      "internal-accounting",
    ]);
    expect(result.value?.[0].modelIds).toEqual([
      "openrouter/anthropic/claude-sonnet-4",
      "openrouter/openai/gpt-5",
    ]);
    expect(result.value?.[1].label).toBe("internal-accounting");
  });

  it("deep-clones accepted source objects and model id arrays", () => {
    const input = VALID_CUSTOM_SOURCE_INPUTS.map((source) => ({
      ...source,
      ...("modelIds" in source ? { modelIds: [...source.modelIds] } : {}),
    }));
    const result = validateCustomSources(input);
    expect(result.value).toBeDefined();
    expect(result.value).not.toBe(input);
    expect(result.value?.[0]).not.toBe(input[0]);
    expect(result.value?.[0].modelIds).not.toBe(input[0].modelIds);

    const cloned = cloneCustomSources(result.value!);
    cloned[0].modelIds![0] = "openrouter/changed";
    expect(result.value?.[0].modelIds?.[0]).toBe("openrouter/anthropic/claude-sonnet-4");
    expect(input[0].modelIds[0]).toBe("openrouter/anthropic/claude-sonnet-4");
  });

  it("atomically rejects non-arrays, non-objects, missing fields, and unknown fields", () => {
    expect(validateCustomSources({}).issues).toEqual([
      { key: "customSources", message: "expected an array" },
    ]);

    const result = validateCustomSources([
      null,
      {
        id: "incomplete",
        executableMapping: "return process.env",
        pricingModels: ["gpt-5"],
      },
    ]);
    expect(result.value).toBeUndefined();
    expect(result.issues.map((issue) => issue.key)).toEqual([
      "customSources[0]",
      "customSources[1].executableMapping",
      "customSources[1].pricingModels",
      "customSources[1].providerId",
      "customSources[1].url",
      "customSources[1].preset",
    ]);
  });

  it("reports discoverable cross-instance issues alongside local field errors", () => {
    const result = validateCustomSources([
      customSource({ id: "duplicate", providerId: "provider-one" }),
      customSource({
        id: "duplicate",
        providerId: "provider-two",
        label: 42,
        url: "https://two.example/",
      }),
    ]);
    expect(result.value).toBeUndefined();
    expect(result.issues).toContainEqual({
      key: "customSources[1].label",
      message: "expected a string",
    });
    expect(result.issues).toContainEqual({
      key: "customSources[1].id",
      message: "duplicates customSources[0].id",
    });
  });

  it("enforces the exact 1-64 source id grammar", () => {
    const sixtyFour = `a${"b".repeat(63)}`;
    expect(validateCustomSources([customSource({ id: sixtyFour })]).issues).toEqual([]);

    for (const id of [
      "",
      "1source",
      "Source",
      "source_one",
      "source--one",
      "-source",
      `a${"b".repeat(64)}`,
    ]) {
      const result = validateCustomSources([customSource({ id })]);
      expect(result.value, id).toBeUndefined();
      expect(
        result.issues.map((issue) => issue.key),
        id,
      ).toContain("customSources[0].id");
    }
  });

  it("rejects the aggregate id and collisions recognized as built-in provider ids", () => {
    for (const id of ["custom-sources", "openai", "claude", "nano-gpt"]) {
      const result = validateCustomSources([customSource({ id })]);
      expect(result.value, id).toBeUndefined();
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].key).toBe("customSources[0].id");
    }
  });

  it("uses the approved exact providerId grammar and 64-character limit", () => {
    const accepted = [
      `p${"a".repeat(63)}`,
      "1provider",
      "openai",
      "provider.name",
      "provider_name",
      "provider--name",
    ];
    for (const providerId of accepted) {
      const result = validateCustomSources([customSource({ providerId })]);
      expect(result.issues, providerId).toEqual([]);
      expect(result.value?.[0].providerId).toBe(providerId);
    }

    for (const providerId of [
      "",
      "Provider",
      "provider/name",
      " provider",
      "provider ",
      `p${"a".repeat(64)}`,
    ]) {
      const result = validateCustomSources([customSource({ providerId })]);
      expect(result.value, providerId).toBeUndefined();
      expect(
        result.issues.map((issue) => issue.key),
        providerId,
      ).toContain("customSources[0].providerId");
    }
  });

  it("defaults omitted labels to id and trims printable Unicode labels", () => {
    const result = validateCustomSources([
      customSource({ id: "default-label", label: undefined }),
      customSource({
        id: "unicode-label",
        label: "  Café 🚀  ",
        url: "https://two.example/",
      }),
    ]);
    expect(result.value).toBeUndefined();
    expect(result.issues).toContainEqual({
      key: "customSources[0].label",
      message: "expected a string",
    });

    const omitted = customSource({ id: "default-label" });
    delete omitted.label;
    const valid = validateCustomSources([
      omitted,
      customSource({
        id: "unicode-label",
        providerId: "provider-two",
        label: "  Café 🚀  ",
        url: "https://two.example/",
      }),
    ]);
    expect(valid.issues).toEqual([]);
    expect(valid.value?.map((source) => source.label)).toEqual(["default-label", "Café 🚀"]);
  });

  it("enforces the 80-code-point printable label limit and allows duplicate labels", () => {
    expect(
      validateCustomSources([
        customSource({ id: "one", label: "Same" }),
        customSource({
          id: "two",
          providerId: "provider-two",
          label: "Same",
          url: "https://two.example/",
        }),
      ]).issues,
    ).toEqual([]);

    for (const label of ["", "   ", "line\nbreak", "tab\tlabel", "x".repeat(81)]) {
      const result = validateCustomSources([customSource({ label })]);
      expect(result.value, JSON.stringify(label)).toBeUndefined();
      expect(result.issues[0].key).toBe("customSources[0].label");
    }
    expect(validateCustomSources([customSource({ label: "🚀".repeat(80) })]).issues).toEqual([]);
  });

  it.each([
    "provider.example/accounting",
    "ftp://provider.example/accounting",
    "https://user:secret@provider.example/accounting",
    "https://provider.example/accounting?token=secret",
    "https://provider.example/accounting#mapping",
    " https://provider.example/accounting",
    "https://provider.example/line\nbreak",
  ])("rejects unsafe or non-absolute URL %s", (url) => {
    const result = validateCustomSources([customSource({ url })]);
    expect(result.value).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].key).toBe("customSources[0].url");
  });

  it("accepts HTTP and stores the canonical URL representation", () => {
    const result = validateCustomSources([customSource({ url: "http://PROVIDER.example:80" })]);
    expect(result.issues).toEqual([]);
    expect(result.value?.[0].url).toBe("http://provider.example/");
  });

  it("rejects canonical duplicate request tuples despite different labels and models", () => {
    const result = validateCustomSources([
      customSource({
        id: "one",
        label: "One",
        url: "https://PROVIDER.example:443/accounting",
        modelIds: ["provider-one/model-a"],
      }),
      customSource({
        id: "two",
        label: "Two",
        url: "https://provider.example/accounting",
        modelIds: ["provider-one/model-b"],
      }),
    ]);
    expect(result.value).toBeUndefined();
    expect(result.issues).toEqual([
      {
        key: "customSources[1].url",
        message: "duplicates request identity from customSources[0]",
      },
    ]);
  });

  it("keeps providerId, preset, and apiKeyEnv in the exact request identity", () => {
    const result = validateCustomSources([
      customSource({
        id: "one",
        modelIds: ["provider-one/model-a"],
      }),
      customSource({
        id: "two",
        label: "Two",
        preset: "openrouter-key-v1",
        modelIds: ["provider-one/model-b"],
      }),
      customSource({
        id: "three",
        label: "Three",
        apiKeyEnv: "THREE_KEY",
        modelIds: ["provider-one/model-c"],
      }),
      customSource({
        id: "four",
        providerId: "provider-two",
        label: "Four",
      }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it("enforces the explicit apiKeyEnv grammar and 128-character limit", () => {
    const maxLength = `A${"_".repeat(127)}`;
    expect(validateCustomSources([customSource({ apiKeyEnv: maxLength })]).issues).toEqual([]);

    for (const apiKeyEnv of [
      "api-key",
      "$API_KEY",
      " api_key",
      "ApiKey",
      "",
      `A${"_".repeat(128)}`,
    ]) {
      const result = validateCustomSources([customSource({ apiKeyEnv })]);
      expect(result.value, apiKeyEnv).toBeUndefined();
      expect(result.issues[0].key).toBe("customSources[0].apiKeyEnv");
    }
  });

  it("rejects duplicate source ids and duplicate exact model ids with indexed diagnostics", () => {
    const duplicateIds = validateCustomSources([
      customSource({ id: "same", providerId: "provider-one" }),
      customSource({
        id: "same",
        providerId: "provider-two",
        url: "https://two.example/",
      }),
    ]);
    expect(duplicateIds.issues).toContainEqual({
      key: "customSources[1].id",
      message: "duplicates customSources[0].id",
    });

    const duplicateModels = validateCustomSources([
      customSource({
        modelIds: ["provider-one/model-a", "provider-one/model-a"],
      }),
    ]);
    expect(duplicateModels.issues).toEqual([
      {
        key: "customSources[0].modelIds[1]",
        message: "duplicates customSources[0].modelIds[0]",
      },
    ]);
  });

  it.each([
    [],
    ["model-without-provider"],
    ["other-provider/model-a"],
    ["provider-one/"],
    ["/model-a"],
    ["provider-one/model a"],
    ["provider-one/model?a"],
    ["provider-one/model#a"],
  ])("rejects invalid exact full model selectors %#", (modelIds) => {
    const result = validateCustomSources([customSource({ modelIds })]);
    expect(result.value).toBeUndefined();
    expect(result.issues[0].key).toMatch(/^customSources\[0\]\.modelIds/);
  });

  it("allows disjoint exact model coverage for one provider and preserves model order", () => {
    const result = validateCustomSources([
      customSource({
        id: "one",
        url: "https://one.example/",
        modelIds: ["provider-one/model-b", "provider-one/model-a"],
      }),
      customSource({
        id: "two",
        url: "https://two.example/",
        modelIds: ["provider-one/model-c"],
      }),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.value?.map((source) => source.modelIds)).toEqual([
      ["provider-one/model-b", "provider-one/model-a"],
      ["provider-one/model-c"],
    ]);
  });

  it("rejects overlapping exact model coverage for one provider", () => {
    const result = validateCustomSources([
      customSource({
        id: "one",
        url: "https://one.example/",
        modelIds: ["provider-one/model-a", "provider-one/model-b"],
      }),
      customSource({
        id: "two",
        url: "https://two.example/",
        modelIds: ["provider-one/model-b", "provider-one/model-c"],
      }),
    ]);
    expect(result.value).toBeUndefined();
    expect(result.issues).toEqual([
      {
        key: "customSources[1].modelIds",
        message: 'source coverage overlaps customSources[0] for providerId "provider-one"',
      },
    ]);
  });

  it("treats omitted modelIds as all-model inclusion and rejects any overlap", () => {
    const allModelsFirst = validateCustomSources([
      customSource({ id: "all-models", url: "https://all.example/" }),
      customSource({
        id: "one-model",
        url: "https://one.example/",
        modelIds: ["provider-one/model-a"],
      }),
    ]);
    expect(allModelsFirst.value).toBeUndefined();
    expect(allModelsFirst.issues[0].key).toBe("customSources[1].modelIds");

    const allModelsSecond = validateCustomSources([
      customSource({
        id: "one-model",
        url: "https://one.example/",
        modelIds: ["provider-one/model-a"],
      }),
      customSource({ id: "all-models", url: "https://all.example/" }),
    ]);
    expect(allModelsSecond.value).toBeUndefined();
    expect(allModelsSecond.issues[0].key).toBe("customSources[1].providerId");
  });

  it("keeps source inclusion separate from models.dev pricing matching", () => {
    const result = validateCustomSources([
      customSource({
        providerId: "openrouter",
        modelIds: ["openrouter/vendor/exact-runtime-model"],
      }),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.value?.[0]).toEqual({
      id: "source-one",
      providerId: "openrouter",
      label: "Source One",
      url: "https://provider.example/accounting",
      preset: "accounting-v1",
      modelIds: ["openrouter/vendor/exact-runtime-model"],
    });
    expect(result.value?.[0]).not.toHaveProperty("pricingModels");
  });
});
