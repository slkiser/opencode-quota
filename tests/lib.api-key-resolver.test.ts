import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFakeIntegration } from "./helpers/fake-integration.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFile: vi.fn(),
  readAuthFile: vi.fn(),
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: join(homedir(), ".local", "share", "opencode"),
    configDir: join(homedir(), ".config", "opencode"),
    cacheDir: join(homedir(), ".cache", "opencode"),
    stateDir: join(homedir(), ".local", "state", "opencode"),
  }),
}));
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: mocks.existsSync,
}));
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  readFile: mocks.readFile,
}));
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  getCredentialDatabasePaths: () => ["/tmp/opencode.db"],
  readAuthFile: mocks.readAuthFile,
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  getAlibabaCodingPlanAuthDiagnostics,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuth,
  resolveAlibabaCodingPlanAuthCached,
} from "../src/lib/alibaba-auth.js";
import {
  API_KEY_VENDORS,
  type ApiKeyLoginSpec,
  getApiKeyLoginDiagnostics,
  getGlobalOpencodeConfigCandidatePaths,
  parseApiKeyLogin,
  resolveApiKey,
  resolveApiKeyFromEnvAndConfig,
  resolveApiKeyLogin,
} from "../src/lib/api-key-resolver.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const TRUSTED = {
  jsonc: join(CONFIG_DIR, "opencode.jsonc"),
  json: join(CONFIG_DIR, "opencode.json"),
};
const WORKSPACE = [join(process.cwd(), "opencode.json"), join(process.cwd(), "opencode.jsonc")];
const DB_PATHS = ["/tmp/opencode.db"];

// The vendor contract, written out by hand instead of read from the production
// tables, so a wrong env var, config alias, or login id in a table fails here.
// Order is precedence: the first env var, config alias, and login id wins.
const EXPECTED_API_KEY_VENDORS: Record<string, ApiKeyLoginSpec> = {
  deepseek: {
    displayName: "DeepSeek",
    envVars: ["DEEPSEEK_API_KEY"],
    providerKeys: ["deepseek"],
    authKeys: ["deepseek"],
    skipBrokenLogins: true,
  },
  "ollama-cloud": {
    displayName: "Ollama Cloud",
    envVars: ["OLLAMA_API_KEY"],
    providerKeys: ["ollama-cloud"],
    authKeys: ["ollama-cloud"],
    skipBrokenLogins: true,
  },
  zai: {
    displayName: "Z.ai",
    envVars: ["ZAI_API_KEY", "ZAI_CODING_PLAN_API_KEY"],
    providerKeys: ["zai", "zai-coding-plan", "glm"],
    authKeys: ["zai-coding-plan"],
  },
  zhipu: {
    displayName: "Zhipu",
    envVars: ["ZHIPU_API_KEY", "ZHIPU_CODING_PLAN_API_KEY"],
    providerKeys: ["zhipu", "zhipu-coding-plan", "zhipuai-coding-plan", "glm-coding-plan"],
    authKeys: ["zhipu-coding-plan", "zhipuai-coding-plan"],
  },
  "opencode-go": {
    displayName: "OpenCode Go",
    envVars: ["OPENCODE_API_KEY"],
    providerKeys: ["opencode-go", "opencode"],
    authKeys: ["opencode-go", "opencode"],
    keyLoginsOnly: true,
    unsupportedTypeError: "OpenCode Go auth entry has unsupported type",
  },
  "kimi-code-plan-global": {
    displayName: "Kimi",
    envVars: ["KIMI_GLOBAL_API_KEY"],
    providerKeys: ["kimi-code-plan-global"],
    authKeys: ["kimi-code-plan-global"],
  },
  "kimi-code-plan-cn": {
    displayName: "Kimi",
    envVars: ["KIMI_CN_API_KEY", "KIMI_API_KEY", "KIMI_CODE_API_KEY"],
    providerKeys: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
    authKeys: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
  },
  "minimax-coding-plan": {
    displayName: "MiniMax",
    envVars: ["MINIMAX_CODING_PLAN_API_KEY", "MINIMAX_API_KEY"],
    providerKeys: ["minimax-coding-plan", "minimax"],
    authKeys: ["minimax-coding-plan"],
  },
  "minimax-china-coding-plan": {
    displayName: "MiniMax",
    envVars: ["MINIMAX_CHINA_CODING_PLAN_API_KEY"],
    providerKeys: [
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ],
    authKeys: ["minimax-china-coding-plan", "minimax-cn-coding-plan"],
  },
  "alibaba-coding-plan": {
    displayName: "Alibaba Coding Plan",
    envVars: ["ALIBABA_CODING_PLAN_API_KEY", "ALIBABA_API_KEY"],
    providerKeys: ["alibaba-coding-plan", "alibaba"],
    authKeys: ["alibaba-coding-plan", "alibaba"],
  },
};

// Each case: [vendor id, expected contract (test inputs), production spec (called)].
const ALL_VENDORS = Object.entries(EXPECTED_API_KEY_VENDORS).map(
  ([id, expected]) =>
    [id, expected, (API_KEY_VENDORS as Record<string, ApiKeyLoginSpec>)[id]] as const,
);
/** The vendors that show a broken stored login as an error. */
const LOGIN_VENDORS = ALL_VENDORS.filter(([, expected]) => !expected.skipBrokenLogins);
const ALL_ENV_VARS = ALL_VENDORS.flatMap(([, expected]) => expected.envVars);

/** One entry per id, each with a value that names its id. */
function entriesFor<T>(ids: readonly string[], value: (id: string) => T): Record<string, T> {
  return Object.fromEntries(ids.map((id) => [id, value(id)]));
}

/** Only these files exist; any other read fails like a missing file. */
function mockConfigFiles(files: Record<string, string>): void {
  mocks.existsSync.mockImplementation((path: string) => Object.hasOwn(files, path));
  mocks.readFile.mockImplementation(async (path: string) => {
    if (!Object.hasOwn(files, path)) throw new Error(`Unexpected read: ${path}`);
    return files[path];
  });
}

function legacyConfig(providers: Record<string, string>): string {
  return JSON.stringify({
    provider: Object.fromEntries(
      Object.entries(providers).map(([id, apiKey]) => [id, { options: { apiKey } }]),
    ),
  });
}

function expectedLoginRead(spec: ApiKeyLoginSpec, maxAgeMs: number) {
  return {
    maxAgeMs,
    integrationIds: spec.authKeys,
    ...(spec.keyLoginsOnly ? { methods: ["key"] } : {}),
  };
}

function unsupportedTypeError(spec: ApiKeyLoginSpec, type: string): string {
  return spec.unsupportedTypeError ?? `Unsupported ${spec.displayName} auth type: "${type}"`;
}

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const name of [...ALL_ENV_VARS, "NOT_ALLOWED", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    delete process.env[name];
  }
  mockConfigFiles({});
  mocks.readAuthFile.mockReset().mockResolvedValue(null);
  mocks.readAuthFileCached.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  process.env = originalEnv;
});

describe("vendor contract", () => {
  it("the production tables match the hand-written contract", () => {
    expect(API_KEY_VENDORS).toEqual(EXPECTED_API_KEY_VENDORS);
  });

  it.each(ALL_VENDORS)(
    "%s: env vars, then config aliases, each in contract order",
    async (_id, expected, spec) => {
      for (const [index, name] of expected.envVars.entries()) {
        for (const later of expected.envVars.slice(index)) process.env[later] = `${later}-value`;
        await expect(resolveApiKeyFromEnvAndConfig(spec)).resolves.toEqual({
          key: `${name}-value`,
          source: `env:${name}`,
        });
        delete process.env[name];
      }
      for (const [index, alias] of expected.providerKeys.entries()) {
        const aliases = expected.providerKeys.slice(index);
        mockConfigFiles({ [TRUSTED.json]: legacyConfig(entriesFor(aliases, (id) => `${id}-key`)) });
        await expect(resolveApiKeyFromEnvAndConfig(spec)).resolves.toEqual({
          key: `${alias}-key`,
          source: "opencode.json",
        });
      }
    },
  );
});

describe("trusted config parsing", () => {
  const spec = API_KEY_VENDORS.deepseek;

  it("lists only the global jsonc and json files", () => {
    expect(getGlobalOpencodeConfigCandidatePaths()).toEqual([
      { path: TRUSTED.jsonc, isJsonc: true },
      { path: TRUSTED.json, isJsonc: false },
    ]);
  });

  it("prefers opencode.jsonc and stops reading once it has a key", async () => {
    mockConfigFiles({
      [TRUSTED.jsonc]:
        '{ // preferred\n "provider": { "deepseek": { "options": { "apiKey": "jsonc-key" } } },\n}',
      [TRUSTED.json]: legacyConfig({ deepseek: "json-key" }),
    });
    await expect(resolveApiKey(spec)).resolves.toEqual({
      key: "jsonc-key",
      source: "opencode.jsonc",
    });
    expect(mocks.readFile.mock.calls.map((call) => call[0])).toEqual([TRUSTED.jsonc]);
  });

  it.each([
    [
      "native settings",
      { providers: { deepseek: { settings: { apiKey: " native-key " } } } },
      "native-key",
    ],
    [
      "native settings over legacy options",
      {
        provider: { deepseek: { options: { apiKey: "legacy-key" } } },
        providers: { deepseek: { settings: { apiKey: "native-key" } } },
      },
      "native-key",
    ],
    [
      "a native entry without settings hides legacy options",
      {
        provider: { deepseek: { options: { apiKey: "legacy-key" } } },
        providers: { deepseek: { name: "DeepSeek" } },
      },
      null,
    ],
    [
      "a malformed (array) native entry also hides legacy options",
      {
        provider: { deepseek: { options: { apiKey: "legacy-key" } } },
        providers: { deepseek: [] },
      },
      null,
    ],
    [
      "legacy options",
      { provider: { deepseek: { options: { apiKey: "legacy-key" } } } },
      "legacy-key",
    ],
  ])("reads %s", async (_label, config, expected) => {
    mockConfigFiles({ [TRUSTED.json]: JSON.stringify(config) });
    const result = await resolveApiKey(spec);
    expect(result?.key ?? null).toBe(expected);
  });

  it("resolves a template naming the vendor's own second env var", async () => {
    // A vendor's own env var wins before config is read, so use a vendor whose
    // first env var is unset and whose template names its second one.
    process.env.ZAI_CODING_PLAN_API_KEY = "templated-key";
    mockConfigFiles({
      [TRUSTED.json]: legacyConfig({ zai: "{env:ZAI_CODING_PLAN_API_KEY}" }),
    });
    await expect(resolveApiKeyLogin(API_KEY_VENDORS.zai)).resolves.toEqual({
      state: "configured",
      apiKey: "templated-key",
    });
  });
});

describe("API key login vendors (a broken stored login is reported, not skipped)", () => {
  it.each(LOGIN_VENDORS)("%s: parses stored logins exactly", (_id, expected, spec) => {
    const withEntry = (entry: unknown) => ({ [expected.authKeys[0]]: entry });

    expect(parseApiKeyLogin(spec, null)).toEqual({ state: "none" });
    expect(parseApiKeyLogin(spec, {})).toEqual({ state: "none" });
    expect(parseApiKeyLogin(spec, withEntry(null))).toEqual({ state: "none" });
    expect(parseApiKeyLogin(spec, withEntry("bad-shape"))).toEqual({
      state: "invalid",
      error: `${expected.displayName} auth entry has invalid shape`,
    });
    expect(parseApiKeyLogin(spec, withEntry({ type: { bad: true }, key: "k" }))).toEqual({
      state: "invalid",
      error: `${expected.displayName} auth entry present but type is missing or invalid`,
    });
    expect(parseApiKeyLogin(spec, withEntry({ type: "oauth", key: "k" }))).toEqual({
      state: "invalid",
      error: unsupportedTypeError(expected, "oauth"),
    });
    expect(parseApiKeyLogin(spec, withEntry({ type: "api", key: " " }))).toEqual({
      state: "invalid",
      error: `${expected.displayName} auth entry present but key is empty`,
    });
    expect(
      parseApiKeyLogin(spec, withEntry({ type: "api", resolveError: "resolve_empty: no value" })),
    ).toEqual({
      state: "invalid",
      error: "OpenCode could not read this login: resolve_empty: no value",
    });
    for (const [index, authKey] of expected.authKeys.entries()) {
      const later = expected.authKeys.slice(index);
      expect(
        parseApiKeyLogin(
          spec,
          entriesFor(later, (id) => ({ type: "api", key: ` ${id}-key ` })),
        ),
      ).toEqual({ state: "configured", apiKey: `${authKey}-key` });
    }
    if (expected.authKeys.length > 1) {
      expect(
        parseApiKeyLogin(spec, {
          [expected.authKeys[0]]: { type: "oauth", key: "ignored" },
          [expected.authKeys[1]]: { type: "api", key: "later-key" },
        }),
      ).toEqual({ state: "invalid", error: unsupportedTypeError(expected, "oauth") });
    }
  });

  it("sanitizes, bounds, and falls back in the unsupported-type error", () => {
    const spec = API_KEY_VENDORS.zai;
    const withType = (type: string) => ({ "zai-coding-plan": { type } });
    expect(parseApiKeyLogin(spec, withType("\u001b[31moauth\nretry\u001b[0m"))).toEqual({
      state: "invalid",
      error: 'Unsupported Z.ai auth type: "oauth retry"',
    });
    expect(parseApiKeyLogin(spec, withType("\u001b[31m"))).toEqual({
      state: "invalid",
      error: 'Unsupported Z.ai auth type: "unknown"',
    });
    expect(parseApiKeyLogin(spec, withType("x".repeat(130)))).toEqual({
      state: "invalid",
      error: `Unsupported Z.ai auth type: "${"x".repeat(120)}"`,
    });
  });

  it("uses a fixed OpenCode Go unsupported-type error that never echoes the login", async () => {
    const secret = "distinctive-go-secret";
    mocks.readAuthFileCached.mockResolvedValue({ "opencode-go": { type: secret, key: secret } });
    const diagnostics = await getApiKeyLoginDiagnostics(API_KEY_VENDORS["opencode-go"]);
    expect(diagnostics).toMatchObject({
      state: "invalid",
      error: "OpenCode Go auth entry has unsupported type",
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it.each(LOGIN_VENDORS)(
    "%s: env keys win in order and skip the stored logins",
    async (_id, expected, spec) => {
      for (const name of expected.envVars) process.env[name] = `${name}-value`;
      mocks.readAuthFileCached.mockResolvedValue({ [expected.authKeys[0]]: { type: "oauth" } });
      await expect(resolveApiKeyLogin(spec)).resolves.toEqual({
        state: "configured",
        apiKey: `${expected.envVars[0]}-value`,
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();

      const lastEnvVar = expected.envVars.at(-1)!;
      for (const name of expected.envVars.slice(0, -1)) delete process.env[name];
      await expect(getApiKeyLoginDiagnostics(spec)).resolves.toEqual({
        state: "configured",
        source: `env:${lastEnvVar}`,
        checkedPaths: [`env:${lastEnvVar}`],
        credentialDatabasePaths: DB_PATHS,
      });
    },
  );

  it.each(LOGIN_VENDORS)(
    "%s: trusted config aliases win over a broken stored login",
    async (_id, expected, spec) => {
      mocks.readAuthFileCached.mockResolvedValue({ [expected.authKeys[0]]: { type: "oauth" } });
      mockConfigFiles({
        [TRUSTED.jsonc]: legacyConfig({
          [expected.providerKeys[0]]: "{env:NOT_ALLOWED}",
          [expected.providerKeys.at(-1)!]: "alias-key",
        }),
      });
      await expect(getApiKeyLoginDiagnostics(spec)).resolves.toEqual({
        state: "configured",
        source: "opencode.jsonc",
        checkedPaths: [TRUSTED.jsonc],
        credentialDatabasePaths: DB_PATHS,
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();

      mockConfigFiles(
        Object.fromEntries(
          WORKSPACE.map((path) => [path, legacyConfig({ [expected.providerKeys[0]]: "k" })]),
        ),
      );
      mocks.readAuthFileCached.mockResolvedValue(null);
      await expect(getApiKeyLoginDiagnostics(spec)).resolves.toEqual({
        state: "none",
        source: null,
        checkedPaths: [],
        credentialDatabasePaths: DB_PATHS,
      });
    },
  );

  it.each(LOGIN_VENDORS)(
    "%s: reads cached stored logins with the vendor's ids",
    async (_id, expected, spec) => {
      mocks.readAuthFileCached.mockResolvedValue({
        [expected.authKeys[0]]: { type: "api", key: "auth-key" },
      });
      await expect(resolveApiKeyLogin(spec)).resolves.toEqual({
        state: "configured",
        apiKey: "auth-key",
      });
      expect(mocks.readAuthFileCached).toHaveBeenLastCalledWith(expectedLoginRead(expected, 5_000));

      mocks.readAuthFileCached.mockResolvedValue({ [expected.authKeys[0]]: { type: "oauth" } });
      await expect(getApiKeyLoginDiagnostics(spec)).resolves.toEqual({
        state: "invalid",
        source: "opencode.db",
        error: unsupportedTypeError(expected, "oauth"),
        checkedPaths: [],
        credentialDatabasePaths: DB_PATHS,
      });
    },
  );
});

describe("per-vendor differences", () => {
  it("gives the legacy Kimi aliases to CN and keeps each region's key apart", async () => {
    const legacy = { kimi: { type: "api", key: "legacy-cn" } };
    expect(parseApiKeyLogin(API_KEY_VENDORS["kimi-code-plan-cn"], legacy)).toEqual({
      state: "configured",
      apiKey: "legacy-cn",
    });
    expect(parseApiKeyLogin(API_KEY_VENDORS["kimi-code-plan-global"], legacy)).toEqual({
      state: "none",
    });

    process.env.MINIMAX_CHINA_CODING_PLAN_API_KEY = "china-key";
    await expect(resolveApiKeyLogin(API_KEY_VENDORS["minimax-coding-plan"])).resolves.toEqual({
      state: "none",
    });
    await expect(resolveApiKeyLogin(API_KEY_VENDORS["minimax-china-coding-plan"])).resolves.toEqual(
      { state: "configured", apiKey: "china-key" },
    );
  });

  it.each([
    [{}, "lite"],
    [{ tier: "PRO" }, "pro"],
    [{ planTier: "professional" }, "pro"],
    [{ plan_tier: "lite" }, "lite"],
    [{ subscriptionTier: " pro " }, "pro"],
  ])("reads the Alibaba plan tier from %j", (tierFields, tier) => {
    expect(
      resolveAlibabaCodingPlanAuth({ alibaba: { type: "api", key: "k", ...tierFields } } as never),
    ).toEqual({
      state: "configured",
      apiKey: "k",
      tier,
    });
  });

  it.each([
    [
      { type: "api", key: "k", tier: "max" },
      { state: "invalid", error: "Unsupported Alibaba Coding Plan tier: max", rawTier: "max" },
    ],
    [
      { type: "api", access: "token" },
      { state: "invalid", error: "Alibaba Coding Plan auth entry present but key is empty" },
    ],
  ])("reports the unusable Alibaba login %j", (entry, expected) => {
    expect(resolveAlibabaCodingPlanAuth({ alibaba: entry } as never)).toEqual(expected);
  });

  it("reports an explicit null Alibaba login as broken, unlike the other vendors", async () => {
    const invalidShape = {
      state: "invalid",
      error: "Alibaba Coding Plan auth entry has invalid shape",
    };
    expect(resolveAlibabaCodingPlanAuth({ "alibaba-coding-plan": null } as never)).toEqual(
      invalidShape,
    );
    expect(resolveAlibabaCodingPlanAuth({ "alibaba-coding-plan": [] } as never)).toMatchObject({
      state: "invalid",
    });

    mocks.readAuthFileCached.mockResolvedValue({ "alibaba-coding-plan": null });
    await expect(getAlibabaCodingPlanAuthDiagnostics()).resolves.toEqual({
      ...invalidShape,
      source: "opencode.db",
      checkedPaths: [],
      credentialDatabasePaths: DB_PATHS,
    });
  });

  it("uses the fallback Alibaba tier for env keys and reports a bad stored tier", async () => {
    process.env.ALIBABA_API_KEY = "env-key";
    await expect(resolveAlibabaCodingPlanAuthCached({ fallbackTier: "pro" })).resolves.toEqual({
      state: "configured",
      apiKey: "env-key",
      tier: "pro",
    });
    expect(mocks.readAuthFileCached).not.toHaveBeenCalled();

    delete process.env.ALIBABA_API_KEY;
    mocks.readAuthFileCached.mockResolvedValue({ alibaba: { type: "api", key: "k", tier: "max" } });
    await expect(getAlibabaCodingPlanAuthDiagnostics()).resolves.toEqual({
      state: "invalid",
      source: "opencode.db",
      error: "Unsupported Alibaba Coding Plan tier: max",
      rawTier: "max",
      checkedPaths: [],
      credentialDatabasePaths: DB_PATHS,
    });
    expect(isAlibabaModelId("Alibaba-CN/qwen3-coder-plus")).toBe(true);
    expect(isAlibabaModelId("openai/gpt-5")).toBe(false);
  });

  it("never resolves the OpenCode Console sign-in while looking for an OpenCode Go key", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/opencode-auth.js")>(
      "../src/lib/opencode-auth.js",
    );
    const consoleSignIn = {
      integrationId: "opencode",
      id: "cred_console",
      label: "default",
      registered: true,
      method: "oauth" as const,
      value: { type: "oauth", methodID: "device", access: "a", refresh: "r", expires: 0 },
    };
    const workspaceKey = {
      integrationId: "opencode",
      id: "cred_workspace",
      label: "default",
      registered: true,
      method: "key" as const,
      value: { type: "key", key: "workspace-key" },
    };
    mocks.readAuthFileCached.mockImplementation(actual.readAuthFileCached);
    const spec = API_KEY_VENDORS["opencode-go"];
    async function withLogins(
      credentials: Parameters<typeof createFakeIntegration>[0],
      check: (integration: ReturnType<typeof createFakeIntegration>) => Promise<void>,
    ) {
      const integration = createFakeIntegration(credentials);
      const unbind = actual.bindCredentialSource(
        actual.createIntegrationCredentialSource(integration as never),
      );
      try {
        await check(integration);
      } finally {
        unbind();
        actual.notifyCredentialsChanged();
      }
    }

    await withLogins([consoleSignIn, workspaceKey], async (signedIn) => {
      await expect(resolveApiKeyLogin(spec)).resolves.toEqual({ state: "none" });
      expect(signedIn.connection.active.mock.calls).toEqual([["opencode-go"], ["opencode"]]);
      expect(signedIn.connection.resolve).not.toHaveBeenCalled();
    });
    await withLogins([workspaceKey], async () => {
      await expect(resolveApiKeyLogin(spec)).resolves.toEqual({
        state: "configured",
        apiKey: "workspace-key",
      });
    });
  });
});
