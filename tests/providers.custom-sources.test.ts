import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomSourceConfig } from "../src/lib/custom-sources.js";
import type { QuotaProviderContext } from "../src/lib/entries.js";

const runtimeMocks = vi.hoisted(() => ({
  resolveCustomSourceApiKey: vi.fn(),
  fetchCustomSource: vi.fn(),
}));

vi.mock("../src/lib/custom-sources-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/custom-sources-runtime.js")>();
  return {
    ...actual,
    resolveCustomSourceApiKey: runtimeMocks.resolveCustomSourceApiKey,
    fetchCustomSource: runtimeMocks.fetchCustomSource,
  };
});

import {
  customSourcesProvider,
  selectEligibleCustomSources,
} from "../src/providers/custom-sources.js";

function source(id: string, providerId: string, modelIds?: string[]): CustomSourceConfig {
  return {
    id,
    providerId,
    label: id,
    url: `https://${id}.example/accounting`,
    preset: "accounting-v1",
    ...(modelIds ? { modelIds } : {}),
  };
}

function context(
  sources: CustomSourceConfig[],
  providerIds: string[],
  selection: Partial<QuotaProviderContext["config"]> = {},
): QuotaProviderContext {
  return {
    client: {
      config: {
        providers: vi.fn().mockResolvedValue({
          data: { providers: providerIds.map((id) => ({ id })) },
        }),
        get: vi.fn(),
      },
    },
    config: {
      googleModels: [],
      alibabaCodingPlanTier: "pro",
      cursorPlan: "auto",
      enabledProviders: "auto",
      customSources: sources,
      onlyCurrentModel: false,
      ...selection,
    },
  };
}

function successEntry(name: string) {
  return {
    accounting: {
      resultType: "quota" as const,
      acquisitionMethod: "remote_api" as const,
      ownership: "user_configured" as const,
      authority: "provider_reported" as const,
    },
    name,
    percentRemaining: 50,
  };
}

describe("custom source exact selection", () => {
  const sources = [
    source("provider-wide", "provider-one"),
    source("model-a", "provider-one", ["provider-one/model-a"]),
    source("other-provider", "provider-two"),
  ];

  it("selects only sources with exact runtime provider IDs when current-model filtering is off", () => {
    expect(
      selectEligibleCustomSources({
        sources,
        availableProviderIds: new Set(["provider-one-alias", "provider-two"]),
      }).map((item) => item.id),
    ).toEqual(["other-provider"]);
  });

  it("uses exact full model selectors and provider identity", () => {
    expect(
      selectEligibleCustomSources({
        sources,
        availableProviderIds: new Set(["provider-one", "provider-two"]),
        onlyCurrentModel: true,
        currentModel: "provider-one/model-a",
        currentProviderID: "provider-one",
      }).map((item) => item.id),
    ).toEqual(["provider-wide", "model-a"]);
  });

  it("constructs an exact selector from provider plus bare model identity", () => {
    expect(
      selectEligibleCustomSources({
        sources,
        availableProviderIds: new Set(["provider-one"]),
        onlyCurrentModel: true,
        currentModel: "model-a",
        currentProviderID: "provider-one",
      }).map((item) => item.id),
    ).toEqual(["provider-wide", "model-a"]);
  });

  it("allows provider-only identity only for provider-wide sources", () => {
    expect(
      selectEligibleCustomSources({
        sources,
        availableProviderIds: new Set(["provider-one"]),
        onlyCurrentModel: true,
        currentProviderID: "provider-one",
      }).map((item) => item.id),
    ).toEqual(["provider-wide"]);
  });

  it.each([
    { currentModel: undefined, currentProviderID: undefined },
    { currentModel: "provider-one/model-a", currentProviderID: "provider-two" },
  ])("fails closed for incomplete or inconsistent identity: %j", (identity) => {
    expect(
      selectEligibleCustomSources({
        sources,
        availableProviderIds: new Set(["provider-one", "provider-two"]),
        onlyCurrentModel: true,
        ...identity,
      }),
    ).toEqual([]);
  });

  it("does not treat unrelated provider catalogs as runtime availability", () => {
    expect(
      selectEligibleCustomSources({
        sources,
        availableProviderIds: new Set(["models.dev/provider-one"]),
      }),
    ).toEqual([]);
  });
});

describe("custom-sources aggregate provider", () => {
  beforeEach(() => {
    runtimeMocks.resolveCustomSourceApiKey.mockReset().mockResolvedValue({
      key: "secret",
      source: "env",
      checkedPaths: ["env:EXPLICIT_KEY"],
      authPaths: ["/trusted/auth.json"],
    });
    runtimeMocks.fetchCustomSource.mockReset();
  });

  it("is one explicit aggregate provider and requires exact runtime availability", async () => {
    const sources = [source("one", "provider-one")];
    await expect(
      customSourcesProvider.isAvailable(context(sources, ["provider-one"])),
    ).resolves.toBe(true);
    await expect(
      customSourcesProvider.isAvailable(context(sources, ["provider-one-alias"])),
    ).resolves.toBe(false);
  });

  it("preserves declaration order when requests complete in reverse order", async () => {
    const sources = [
      source("first", "provider-one"),
      source("second", "provider-two"),
      source("third", "provider-three"),
    ];
    runtimeMocks.fetchCustomSource.mockImplementation(async (item: CustomSourceConfig) => {
      const delay = item.id === "first" ? 15 : item.id === "second" ? 8 : 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { success: true, entries: [successEntry(item.id)] };
    });

    const result = await customSourcesProvider.fetch(
      context(sources, ["provider-one", "provider-two", "provider-three"]),
    );

    expect(result.entries.map((entry) => entry.name)).toEqual(["first", "second", "third"]);
    expect(result.errors).toEqual([]);
    expect(result.diagnostics?.map((item) => item.sourceId)).toEqual(["first", "second", "third"]);
  });

  it("returns entry-bearing partial success with per-instance errors and internal diagnostics", async () => {
    const sources = [source("good", "provider-one"), source("bad", "provider-two")];
    runtimeMocks.fetchCustomSource.mockImplementation(async (item: CustomSourceConfig) =>
      item.id === "good"
        ? { success: true, entries: [successEntry("good")] }
        : { success: false, error: "Invalid JSON response" },
    );

    const result = await customSourcesProvider.fetch(
      context(sources, ["provider-one", "provider-two"]),
    );

    expect(result).toEqual({
      attempted: true,
      entries: [successEntry("good")],
      errors: [{ label: "bad", message: "Invalid JSON response" }],
      diagnostics: [
        {
          sourceId: "good",
          providerId: "provider-one",
          selected: true,
          attempted: true,
          credentialSource: "explicit_env",
          outcome: "success",
          entryCount: 1,
          checkedPaths: ["env:EXPLICIT_KEY"],
          authPaths: ["/trusted/auth.json"],
        },
        {
          sourceId: "bad",
          providerId: "provider-two",
          selected: true,
          attempted: true,
          credentialSource: "explicit_env",
          outcome: "invalid_json",
          entryCount: 0,
          checkedPaths: ["env:EXPLICIT_KEY"],
          authPaths: ["/trusted/auth.json"],
        },
      ],
    });
  });

  it("reports missing auth without calling the endpoint or exposing credentials", async () => {
    runtimeMocks.resolveCustomSourceApiKey.mockResolvedValue({
      source: null,
      checkedPaths: ["/trusted/opencode.json"],
      authPaths: ["/trusted/auth.json"],
    });

    const result = await customSourcesProvider.fetch(
      context([source("missing", "provider-one")], ["provider-one"]),
    );

    expect(runtimeMocks.fetchCustomSource).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([{ label: "missing", message: "API key not configured" }]);
    expect(result.diagnostics).toEqual([
      {
        sourceId: "missing",
        providerId: "provider-one",
        selected: true,
        attempted: false,
        credentialSource: null,
        outcome: "missing_credential",
        entryCount: 0,
        checkedPaths: ["/trusted/opencode.json"],
        authPaths: ["/trusted/auth.json"],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("fails closed when runtime provider identity cannot be read", async () => {
    const ctx = context([source("one", "provider-one")], ["provider-one"]);
    vi.mocked(ctx.client.config.providers).mockRejectedValue(new Error("private URL secret"));

    await expect(customSourcesProvider.fetch(ctx)).resolves.toEqual({
      attempted: true,
      entries: [],
      errors: [
        {
          label: "Custom sources",
          message: "Failed to read exact runtime provider identities",
        },
      ],
    });
  });
});
