import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProviderContext } from "../src/lib/entries.js";
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
    format: "accounting-v1",
    ...(modelIds ? { modelIds } : {}),
  };
}

function context(
  definitions: QuotaProviderDefinition[],
  availableProviderIds: string[],
  overrides: Partial<QuotaProviderContext["config"]> = {},
): QuotaProviderContext {
  return {
    client: {
      config: {
        providers: async () => ({
          data: { providers: availableProviderIds.map((id) => ({ id })) },
        }),
        get: async () => ({ data: {} }),
      },
    },
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

  it("reports stable cache/diagnostic identity without secret values", async () => {
    const result = await quotaProvidersProvider.fetch(
      context([remote("stable", "runtime-provider")], ["runtime-provider"]),
    );
    expect(result.diagnostics?.[0]).toMatchObject({
      sourceId: "stable",
      providerId: "runtime-provider",
      mode: "remote-api",
      format: "accounting-v1",
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
