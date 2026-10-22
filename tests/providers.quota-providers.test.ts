import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QuotaProviderContext } from "../src/lib/entries.js";
import { bindCredentialSource } from "../src/lib/opencode-auth.js";
import type {
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../src/lib/quota-providers.js";
import { createRuntimeProviderIdResolver } from "../src/lib/runtime-provider-ids.js";
import type { ProviderFetchResult, ProviderRow } from "../src/providers/contract.js";
import { NO_PROJECT_DIRECTORY, useOpencodeFolders } from "./helpers/opencode-folders.js";

useOpencodeFolders();

const runtimeMocks = vi.hoisted(() => ({
  resolveQuotaProviderApiKey: vi.fn(),
  fetchRemoteQuotaProvider: vi.fn(),
  collectLocalQuotaProviderEstimate: vi.fn(),
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
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: vi.fn(
    async (params: { providerId: string; principal: { value: string } }) =>
      `opaque:${params.providerId}:${params.principal.value}`,
  ),
  composeResolvedAuthIdentities: vi.fn(
    async (params: { providerId: string; identities: readonly string[] }) =>
      `opaque:${params.providerId}:${params.identities.join("|")}`,
  ),
}));

import { quotaProvidersProvider } from "../src/providers/quota-providers.js";

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
    url: `https://${id}.example/accounting`,
    format: "quota-v1",
    ...(modelIds ? { modelIds } : {}),
  };
}

function local(id: string, label = id): QuotaProviderDefinition {
  return {
    id,
    providerId: id,
    label,
    mode: "local-estimate",
    windows: [{ id: "daily", label: "Daily", type: "utc-day", requestLimit: 10 }],
  };
}

/** A remote row; an adapter keys it by its name, the provider adds `custom.<definition id>.`. */
function adapterRow(
  key: string,
  value: { percentRemaining: number } | { text: string },
  label = key,
) {
  return {
    key,
    label,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...value,
  } satisfies ProviderRow;
}

/** Each definition's check, as /quota_status shows it. */
function checks(result: ProviderFetchResult): string[] {
  return result.debug.map((item) => `${item.key}: ${item.value}`);
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
    },
  };
  return {
    client,
    resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client),
    locationDirectory: NO_PROJECT_DIRECTORY,
    config: {
      anthropicBinaryPath: "claude",
      cursorPlan: "none",
      enabledProviders: [],
      quotaProviders: definitions,
      ...overrides,
    },
  };
}

describe("quota-providers aggregate provider", () => {
  beforeEach(() => {
    runtimeMocks.resolveQuotaProviderApiKey.mockReset().mockResolvedValue({
      key: "secret",
      source: "opencode.db",
      checkedPaths: ["/trusted/opencode.json"],
      credentialDatabasePaths: ["/trusted/opencode.db"],
    });
    runtimeMocks.fetchRemoteQuotaProvider.mockReset().mockResolvedValue({
      success: true,
      rows: [],
    });
    runtimeMocks.collectLocalQuotaProviderEstimate.mockReset().mockResolvedValue({ rows: [] });
  });

  it.each([
    ["no runtime match", [remote("stable", "provider-one", ["model-a"])], ["unrelated"], {}, []],
    [
      "an exact runtime match",
      [remote("stable", "provider-one", ["model-a"])],
      ["provider-one"],
      {},
      ["stable"],
    ],
    [
      "a session provider that disagrees with the model prefix",
      [remote("stable", "provider-one", ["model-a"])],
      ["provider-one"],
      {
        onlyCurrentModel: true,
        currentModel: "provider-one/model-a",
        currentProviderID: "provider-two",
      },
      [],
    ],
    [
      "project providers as read-only matching inputs",
      [
        remote("stable-one", "project-provider", ["model-a"]),
        remote("stable-two", "other-provider"),
      ],
      ["project-provider"],
      {},
      ["stable-one"],
    ],
    [
      "the current model of a project provider",
      [
        remote("stable-one", "project-provider", ["model-a"]),
        remote("stable-two", "other-provider"),
      ],
      ["project-provider"],
      { onlyCurrentModel: true, currentProviderID: "project-provider", currentModel: "model-a" },
      ["stable-one"],
    ],
    [
      "a slash-containing model id when the provider is supplied",
      [remote("openrouter-usage", "openrouter", ["openai/gpt-4o"])],
      ["openrouter"],
      { onlyCurrentModel: true, currentProviderID: "openrouter", currentModel: "openai/gpt-4o" },
      ["openrouter-usage"],
    ],
  ] as const)(
    "selects definitions for %s",
    async (_name, definitions, ids, overrides, expected) => {
      const ctx = context([...definitions], [...ids], overrides);
      await expect(quotaProvidersProvider.isAvailable(ctx)).resolves.toBe(expected.length > 0);
      const result = await quotaProvidersProvider.fetch(ctx);
      expect(result.accounts.map((account) => account.login)).toEqual(expected);
    },
  );

  it("treats a slash-containing current model as opaque when matching the session", () => {
    expect(
      quotaProvidersProvider.matchesCurrentModel?.("openai/gpt-4o", {
        enabledProviders: "auto",
        currentProviderID: "openrouter",
        quotaProviders: [remote("openrouter-usage", "openrouter", ["openai/gpt-4o"])],
      }),
    ).toBe(true);
  });

  it("fails closed when the runtime provider catalog cannot be read", async () => {
    const brokenCatalog = context([remote("stable", "provider-one")], ["provider-one"]);
    brokenCatalog.client.config.providers = async () => {
      throw new Error("catalog unavailable");
    };
    await expect(quotaProvidersProvider.fetch(brokenCatalog)).resolves.toEqual({
      attempted: true,
      accounts: [
        {
          name: "Custom providers",
          rows: [],
          errors: [{ message: "Failed to read exact runtime provider identities" }],
        },
      ],
      debug: [],
    });
  });

  it("runs selected definitions in config order even when completion order differs", async () => {
    const definitions = [remote("first"), remote("second")];
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(
      async (definition: RemoteApiQuotaProviderDefinition) => {
        if (definition.id === "first") await new Promise((resolve) => setTimeout(resolve, 10));
        return { success: true, rows: [adapterRow("Monthly", { percentRemaining: 50 })] };
      },
    );

    const result = await quotaProvidersProvider.fetch(context(definitions, ["first", "second"]));
    expect(result.accounts.flatMap((account) => account.rows.map((row) => row.key))).toEqual([
      "custom.first.Monthly",
      "custom.second.Monthly",
    ]);
    expect(result.debug.map((item) => item.key)).toEqual([
      "custom_first_check",
      "custom_second_check",
    ]);
  });

  it("preserves successful entries when another definition fails", async () => {
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(
      async (definition: RemoteApiQuotaProviderDefinition) =>
        definition.id === "bad"
          ? {
              success: false,
              error: "HTTP 503",
              outcome: "http_error",
              facts: { code: "provider_error", status: 503 },
            }
          : { success: true, rows: [adapterRow("Balance", { text: "$5.00" })] },
    );

    const result = await quotaProvidersProvider.fetch(
      context([remote("good"), remote("bad")], ["good", "bad"]),
    );
    expect(result.accounts).toEqual([
      {
        name: "good",
        login: "good",
        rows: [adapterRow("custom.good.Balance", { text: "$5.00" }, "Balance")],
        errors: [],
      },
      {
        name: "bad",
        login: "bad",
        rows: [],
        errors: [{ message: "HTTP 503", facts: { code: "provider_error", status: 503 } }],
      },
    ]);
    expect(result.debug.map((item) => item.value.split(" ")[0])).toEqual([
      "outcome=success",
      "outcome=http_error",
    ]);
  });

  const json = { "content-type": "application/json" };
  it.each([
    ["HTTP 503", () => new Response("{}", { status: 503 }), "outcome=http_error http_status=503"],
    ["Redirect rejected", () => new Response(null, { status: 302 }), "outcome=redirect_error"],
    [
      "Response exceeded 262144 bytes",
      () => new Response("{}", { headers: { ...json, "content-length": "262145" } }),
      "outcome=body_too_large",
    ],
    ["Expected a JSON response", () => new Response("{}"), "outcome=invalid_content_type"],
    ["Invalid JSON response", () => new Response("{", { headers: json }), "outcome=invalid_json"],
    [
      "Invalid quota-v1 response",
      () => new Response("{}", { headers: json }),
      "outcome=invalid_response",
    ],
    [
      "Failed to read accounting data",
      () => Promise.reject(new Error("fetch failed")),
      "outcome=network_error",
    ],
  ])("names the remote error %j in the check", async (error, respond, outcome) => {
    const actual = await vi.importActual<typeof import("../src/lib/quota-providers-remote.js")>(
      "../src/lib/quota-providers-remote.js",
    );
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(actual.fetchRemoteQuotaProvider);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond()),
    );
    const result = await quotaProvidersProvider.fetch(context([remote("bad")], ["bad"]));
    expect(result.accounts).toEqual([
      {
        name: "bad",
        login: "bad",
        rows: [],
        errors: [expect.objectContaining({ message: error })],
      },
    ]);
    expect(checks(result)).toEqual([
      `custom_bad_check: ${outcome} credential_source=opencode_db checked_paths=/trusted/opencode.json | /trusted/opencode.db`,
    ]);
  });

  it("names a timeout in the check", async () => {
    runtimeMocks.fetchRemoteQuotaProvider.mockResolvedValue({
      success: false,
      error: "Request timeout after 5s",
      outcome: "timeout",
      facts: { code: "timeout" },
    });
    const result = await quotaProvidersProvider.fetch(context([remote("bad")], ["bad"]));
    expect(result.accounts[0]?.errors).toEqual([
      { message: "Request timeout after 5s", facts: { code: "timeout" } },
    ]);
    expect(checks(result)[0]).toMatch(/^custom_bad_check: outcome=timeout /u);
  });

  it("reports a missing API key without calling the endpoint", async () => {
    runtimeMocks.resolveQuotaProviderApiKey.mockResolvedValue({
      source: null,
      checkedPaths: ["/trusted/opencode.json"],
      credentialDatabasePaths: [],
    });
    const result = await quotaProvidersProvider.fetch(context([remote("keyless")], ["keyless"]));
    expect(result.accounts[0]?.errors).toEqual([{ message: "API key not configured" }]);
    expect(checks(result)).toEqual([
      "custom_keyless_check: outcome=missing_credential credential_source=(none) checked_paths=/trusted/opencode.json",
    ]);
    expect(runtimeMocks.fetchRemoteQuotaProvider).not.toHaveBeenCalled();
  });

  it("propagates json-v1 row errors as partial output while keeping the check successful", async () => {
    const definition: RemoteApiQuotaProviderDefinition = {
      ...remote("json-partial", "json-provider"),
      label: "JSON Partial",
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
      rows: [adapterRow("Usage", { text: "0" })],
      rowErrors: ["adapter.mappings[0].metric.value was null at row 1"],
    });

    const result = await quotaProvidersProvider.fetch(context([definition], ["json-provider"]));

    expect(result.accounts).toEqual([
      {
        name: "JSON Partial",
        login: "json-partial",
        rows: [adapterRow("custom.json-partial.Usage", { text: "0" }, "Usage")],
        errors: [{ message: "adapter.mappings[0].metric.value was null at row 1" }],
      },
    ]);
    expect(checks(result)[0]).toMatch(/^custom_json-partial_check: outcome=success /u);
  });

  it.each([
    ["opencode.db", "opencode_db"],
    ["opencode.json", "global_opencode_json"],
    ["opencode.jsonc", "global_opencode_jsonc"],
    ["env", "explicit_env"],
  ])("reports where a %s key came from without the key", async (source, credentialSource) => {
    runtimeMocks.resolveQuotaProviderApiKey.mockResolvedValue({
      key: "secret",
      source,
      checkedPaths: ["/trusted/opencode.json"],
      credentialDatabasePaths: ["/trusted/opencode.db"],
    });
    const result = await quotaProvidersProvider.fetch(
      context([remote("stable", "runtime-provider")], ["runtime-provider"]),
    );
    expect(checks(result)).toEqual([
      `custom_stable_check: outcome=success credential_source=${credentialSource} checked_paths=/trusted/opencode.json | /trusted/opencode.db`,
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns a local read error without blocking other definitions", async () => {
    runtimeMocks.collectLocalQuotaProviderEstimate.mockRejectedValue(new Error("database locked"));

    const result = await quotaProvidersProvider.fetch(
      context([local("local", "Local")], ["local"]),
    );
    expect(result.accounts).toEqual([
      {
        name: "Local",
        login: "local",
        rows: [],
        errors: [{ message: "Failed to read OpenCode's messages" }],
      },
    ]);
    expect(checks(result)).toEqual(["custom_local_check: outcome=local_read_error"]);
  });

  it("makes no request and reads no key or login for switched-off definitions", async () => {
    // The real key lookup and request, so every key and login read is seen.
    const actual = await vi.importActual<typeof import("../src/lib/quota-providers-remote.js")>(
      "../src/lib/quota-providers-remote.js",
    );
    runtimeMocks.resolveQuotaProviderApiKey.mockImplementation(actual.resolveQuotaProviderApiKey);
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(actual.fetchRemoteQuotaProvider);
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: "quota-v1", entries: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("ON_GATEWAY_KEY", "on-key");
    vi.stubEnv("OFF_GATEWAY_KEY", "off-key");
    const on = { ...remote("on-gateway"), apiKeyEnv: "ON_GATEWAY_KEY" };
    const ctx = context(
      [
        on,
        { ...remote("off-gateway"), apiKeyEnv: "OFF_GATEWAY_KEY", enabled: false },
        { ...local("off-local"), enabled: false },
      ],
      ["on-gateway", "off-gateway", "off-local"],
    );
    const loginReads: string[] = [];
    const variableReads: string[] = [];
    const unbind = bindCredentialSource({
      kind: "sqlite",
      async readRows({ integrationIds }) {
        loginReads.push(...integrationIds);
        return [];
      },
    });
    const realEnv = process.env;
    process.env = new Proxy(realEnv, {
      get(target, name) {
        if (typeof name === "string") variableReads.push(name);
        return Reflect.get(target, name);
      },
    });

    let result: ProviderFetchResult;
    try {
      result = await quotaProvidersProvider.fetch(ctx);
    } finally {
      process.env = realEnv;
      unbind();
    }

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(on.url, expect.anything());
    expect(variableReads).toContain("ON_GATEWAY_KEY");
    expect(variableReads).not.toContain("OFF_GATEWAY_KEY");
    expect(loginReads).not.toContain("off-gateway");
    expect(runtimeMocks.collectLocalQuotaProviderEstimate).not.toHaveBeenCalled();
    expect(result.accounts.map((account) => account.login)).toEqual(["on-gateway"]);
    expect(result.debug.map((item) => item.key)).toEqual(["custom_on-gateway_check"]);
  });
});
