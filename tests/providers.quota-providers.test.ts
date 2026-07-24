import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProviderContext } from "../src/lib/entries.js";
import { createRuntimeProviderIdResolver } from "../src/lib/runtime-provider-ids.js";
import type {
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../src/lib/quota-providers.js";

const runtimeMocks = vi.hoisted(() => ({
  resolveQuotaProviderApiKey: vi.fn(),
  fetchRemoteQuotaProvider: vi.fn(),
  collectLocalQuotaProviderEstimate: vi.fn(),
  inspectLocalQuotaProviderState: vi.fn(),
}));

vi.mock("../src/lib/quota-providers-remote.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quota-providers-remote.js")>();
  return {
    ...actual,
    resolveQuotaProviderApiKey: runtimeMocks.resolveQuotaProviderApiKey,
    fetchRemoteQuotaProvider: runtimeMocks.fetchRemoteQuotaProvider,
  };
});

vi.mock("../src/lib/quota-providers-local.js", () => ({
  collectLocalQuotaProviderEstimate: runtimeMocks.collectLocalQuotaProviderEstimate,
  inspectLocalQuotaProviderState: runtimeMocks.inspectLocalQuotaProviderState,
}));

import {
  QUOTA_PROVIDERS_PROVIDER_ID,
  quotaProvidersProvider,
  selectEligibleQuotaProviders,
} from "../src/providers/quota-providers.js";

function remote(
  id: string,
  providerId = id,
  modelIds?: string[],
): RemoteApiQuotaProviderDefinition {
  return {
    id,
    providerId,
    label: id,
    mode: "remote-api",
    url: "https://" + id + ".example/accounting",
    format: "quota-v1",
    ...(modelIds ? { modelIds } : {}),
  };
}

function context(
  definitions: QuotaProviderDefinition[],
  availableProviderIds: string[],
  overrides: Partial<QuotaProviderContext["config"]> = {},
): QuotaProviderContext {
  const client = {
    config: {
      providers: async () => ({
        data: { providers: availableProviderIds.map((id) => ({ id })) },
      }),
      get: async () => ({ data: {} }),
    },
  };
  return {
    client,
    resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client),
    config: {
      googleModels: [],
      anthropicBinaryPath: "claude",
      cursorPlan: "none",
      opencodeGoWindows: ["rolling", "weekly", "monthly"],
      enabledProviders: "auto",
      quotaProviders: definitions,
      ...overrides,
    },
  };
}

describe("quota-providers aggregate provider", () => {
  beforeEach(() => {
    runtimeMocks.resolveQuotaProviderApiKey.mockReset().mockResolvedValue({
      key: "secret",
      source: "auth.json",
      checkedPaths: ["/trusted/opencode.json"],
      authPaths: ["/trusted/auth.json"],
    });
    runtimeMocks.fetchRemoteQuotaProvider.mockReset().mockResolvedValue({
      success: true,
      entries: [],
    });
    runtimeMocks.collectLocalQuotaProviderEstimate.mockReset().mockResolvedValue({
      entries: [],
      state: {
        version: 1,
        definitionId: "local",
        providerId: "local",
        updatedAt: 1,
        messages: [],
      },
      unpricedMessageCount: 0,
    });
    runtimeMocks.inspectLocalQuotaProviderState.mockReset().mockResolvedValue({
      path: "/state/local.json",
      exists: true,
      health: "healthy",
      version: 1,
      lastUpdatedAt: 1,
    });
  });

  it("uses one stable aggregate identity", () => {
    expect(QUOTA_PROVIDERS_PROVIDER_ID).toBe("quota-providers");
    expect(quotaProvidersProvider.id).toBe("quota-providers");
  });

  it("reuses the request-scoped runtime provider snapshot", async () => {
    const ctx = context([remote("stable", "provider-one")], ["provider-one"]);
    const providers = vi.spyOn(ctx.client.config, "providers");

    await expect(
      Promise.all([
        quotaProvidersProvider.isAvailable(ctx),
        quotaProvidersProvider.isAvailable(ctx),
      ]),
    ).resolves.toEqual([true, true]);
    expect(providers).toHaveBeenCalledOnce();
  });

  it("requires exact runtime availability and fails closed for inconsistent session or catalog identity", async () => {
    const definitions = [remote("stable", "provider-one", ["model-a"])];

    await expect(
      quotaProvidersProvider.isAvailable(context(definitions, ["unrelated"])),
    ).resolves.toBe(false);
    await expect(
      quotaProvidersProvider.isAvailable(context(definitions, ["provider-one"])),
    ).resolves.toBe(true);

    expect(
      selectEligibleQuotaProviders({
        definitions,
        availableProviderIds: new Set(["provider-one"]),
        onlyCurrentModel: true,
        currentModel: "provider-one/model-a",
        currentProviderID: "provider-two",
      }),
    ).toEqual([]);

    const brokenCatalog = context(definitions, ["provider-one"]);
    brokenCatalog.client.config.providers = async () => {
      throw new Error("catalog unavailable");
    };
    await expect(quotaProvidersProvider.fetch(brokenCatalog)).resolves.toEqual({
      attempted: true,
      entries: [],
      errors: [
        {
          label: "Quota providers",
          message: "Failed to read exact runtime provider identities",
        },
      ],
    });
  });

  it("uses effective project provider declarations only as read-only matching inputs", () => {
    const definitions = [
      remote("stable-one", "project-provider", ["model-a"]),
      remote("stable-two", "other-provider"),
    ];
    expect(
      selectEligibleQuotaProviders({
        definitions,
        availableProviderIds: new Set(["project-provider"]),
      }).map((definition) => definition.id),
    ).toEqual(["stable-one"]);

    expect(
      selectEligibleQuotaProviders({
        definitions,
        availableProviderIds: new Set(["project-provider"]),
        onlyCurrentModel: true,
        currentProviderID: "project-provider",
        currentModel: "model-a",
      }).map((definition) => definition.id),
    ).toEqual(["stable-one"]);
  });

  it("treats slash-containing currentModel as an opaque model id when provider is supplied", () => {
    const definitions = [remote("openrouter-usage", "openrouter", ["openai/gpt-4o"])];

    expect(
      selectEligibleQuotaProviders({
        definitions,
        availableProviderIds: new Set(["openrouter"]),
        onlyCurrentModel: true,
        currentProviderID: "openrouter",
        currentModel: "openai/gpt-4o",
      }).map((definition) => definition.id),
    ).toEqual(["openrouter-usage"]);

    expect(
      quotaProvidersProvider.matchesCurrentModel?.("openai/gpt-4o", {
        enabledProviders: "auto",
        currentProviderID: "openrouter",
        quotaProviders: definitions,
      }),
    ).toBe(true);
  });

  it("skips maintained Qwen and Alibaba tuning in the aggregate", () => {
    const definitions: QuotaProviderDefinition[] = [
      {
        id: "qwen-code",
        providerId: "qwen-code",
        label: "qwen-code",
        mode: "local-estimate",
        windows: [
          { id: "daily", label: "daily", type: "utc-day", requestLimit: 1000 },
          {
            id: "rpm",
            label: "rpm",
            type: "rolling",
            durationMinutes: 1,
            requestLimit: 60,
          },
        ],
      },
      remote("custom"),
    ];
    expect(
      selectEligibleQuotaProviders({
        definitions,
        availableProviderIds: new Set(["qwen-code", "custom"]),
      }).map((definition) => definition.id),
    ).toEqual(["custom"]);
  });

  it("runs selected definitions in config order even when completion order differs", async () => {
    const definitions = [remote("first"), remote("second")];
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(
      async (definition: RemoteApiQuotaProviderDefinition) => {
        if (definition.id === "first") await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          success: true,
          entries: [
            {
              accounting: {
                resultType: "quota",
                acquisitionMethod: "remote_api",
                ownership: "user_configured",
                authority: "provider_reported",
              },
              name: definition.id,
              percentRemaining: 50,
            },
          ],
        };
      },
    );

    const result = await quotaProvidersProvider.fetch(context(definitions, ["first", "second"]));
    expect(result.entries.map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(result.diagnostics?.map((diagnostic) => diagnostic.sourceId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("refreshes mixed local data while retaining remote definition caching", async () => {
    const definitions: QuotaProviderDefinition[] = [
      remote("mixed-remote"),
      {
        id: "mixed-local",
        providerId: "mixed-local",
        label: "Mixed Local",
        mode: "local-estimate",
        windows: [{ id: "daily", label: "Daily", type: "utc-day", requestLimit: 10 }],
      },
    ];
    runtimeMocks.fetchRemoteQuotaProvider.mockResolvedValue({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "balance",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          kind: "value",
          name: "Remote",
          value: "$5.00",
        },
      ],
    });
    let localCall = 0;
    runtimeMocks.collectLocalQuotaProviderEstimate.mockImplementation(async () => {
      localCall += 1;
      return {
        entries: [
          {
            accounting: {
              resultType: "rate_limit",
              acquisitionMethod: "local_estimation",
              ownership: "user_configured",
              authority: "locally_derived",
            },
            name: "Local",
            percentRemaining: 100 - localCall,
          },
        ],
        state: {
          version: 1,
          definitionId: "mixed-local",
          providerId: "mixed-local",
          updatedAt: localCall,
          messages: [],
        },
        unpricedMessageCount: 0,
      };
    });
    const ctx = context(definitions, ["mixed-remote", "mixed-local"], {
      providerCacheTtlMs: 0,
    });

    const first = await quotaProvidersProvider.fetch(ctx);
    ctx.config.providerCacheTtlMs = 60_000;
    const second = await quotaProvidersProvider.fetch(ctx);

    expect(runtimeMocks.fetchRemoteQuotaProvider).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.collectLocalQuotaProviderEstimate).toHaveBeenCalledTimes(2);
    expect(first.entries.map((entry) => entry.name)).toEqual(["Remote", "Local"]);
    expect(second.entries.find((entry) => entry.name === "Local")?.percentRemaining).toBe(98);
  });

  it("preserves successful entries when another definition fails", async () => {
    const definitions = [remote("good"), remote("bad")];
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(
      async (definition: RemoteApiQuotaProviderDefinition) =>
        definition.id === "bad"
          ? { success: false, error: "HTTP 503" }
          : {
              success: true,
              entries: [
                {
                  accounting: {
                    resultType: "balance",
                    acquisitionMethod: "remote_api",
                    ownership: "user_configured",
                    authority: "provider_reported",
                  },
                  kind: "value",
                  name: "good",
                  value: "$5.00",
                },
              ],
            },
    );

    const result = await quotaProvidersProvider.fetch(context(definitions, ["good", "bad"]));
    expect(result.entries).toHaveLength(1);
    expect(result.errors).toEqual([{ label: "bad", message: "HTTP 503" }]);
    expect(result.diagnostics?.map((diagnostic) => diagnostic.outcome)).toEqual([
      "success",
      "http_error",
    ]);
  });

  it("propagates json-v1 row errors as partial output while keeping source diagnostics successful", async () => {
    const definition: RemoteApiQuotaProviderDefinition = {
      id: "json-partial",
      providerId: "json-provider",
      label: "JSON Partial",
      mode: "remote-api",
      url: "https://json-provider.example/quota",
      format: "json-v1",
      adapter: {
        mappings: [
          {
            resultType: "usage",
            name: "Usage",
            metric: { type: "value", valueType: "used", value: { path: ["used"] } },
          },
        ],
      },
    };
    runtimeMocks.fetchRemoteQuotaProvider.mockResolvedValue({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "usage",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          kind: "value",
          name: "JSON Partial Usage",
          value: "0",
        },
      ],
      rowErrors: ["adapter.mappings[0].metric.value was null at row 1"],
    });

    const result = await quotaProvidersProvider.fetch(context([definition], ["json-provider"]));

    expect(result.entries[0]?.accounting.sourceId).toBe("json-partial");
    expect(result.errors).toEqual([
      {
        label: "JSON Partial",
        message: "adapter.mappings[0].metric.value was null at row 1",
      },
    ]);
    expect(result.diagnostics?.[0]).toMatchObject({
      sourceId: "json-partial",
      format: "json-v1",
      outcome: "success",
      entryCount: 1,
    });
  });

  it("reports stable cache/diagnostic identity without secret values", async () => {
    const result = await quotaProvidersProvider.fetch(
      context([remote("stable", "runtime-provider")], ["runtime-provider"]),
    );
    expect(result.diagnostics?.[0]).toMatchObject({
      sourceId: "stable",
      providerId: "runtime-provider",
      mode: "remote-api",
      format: "quota-v1",
      credentialSource: "auth_json",
      checkedPaths: ["/trusted/opencode.json"],
      authPaths: ["/trusted/auth.json"],
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret");
  });

  it("returns a local-state error without blocking other definitions", async () => {
    const local: QuotaProviderDefinition = {
      id: "local",
      providerId: "local",
      label: "Local",
      mode: "local-estimate",
      windows: [{ id: "daily", label: "Daily", type: "utc-day", requestLimit: 10 }],
    };
    runtimeMocks.collectLocalQuotaProviderEstimate.mockRejectedValue(new Error("disk"));

    const result = await quotaProvidersProvider.fetch(context([local], ["local"]));
    expect(result.errors).toEqual([
      { label: "Local", message: "Failed to update local accounting state" },
    ]);
    expect(result.diagnostics?.[0]).toMatchObject({
      sourceId: "local",
      outcome: "local_state_error",
      statePath: "/state/local.json",
    });
  });
});
