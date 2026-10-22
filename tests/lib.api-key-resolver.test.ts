import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CredentialRow } from "../src/lib/opencode-auth.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFile: vi.fn(),
  readActiveCredentialRowsCached: vi.fn(),
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
  readActiveCredentialRowsCached: mocks.readActiveCredentialRowsCached,
}));

import {
  API_KEY_VENDORS,
  type ApiKeyLoginSpec,
  getApiKeyLoginDiagnostics,
  firstLoginRow,
  parseApiKeyLogin,
  resolveApiKey,
  resolveApiKeyFromEnvAndConfig,
  resolveApiKeyLogin,
} from "../src/lib/api-key-resolver.js";

// Never created: every config file read and existence check below is mocked.
const FAKE_ROOT = join(tmpdir(), "opencode-quota-api-key-resolver");
const CONFIG_DIR = join(FAKE_ROOT, "config", "opencode");
const TRUSTED = {
  jsonc: join(CONFIG_DIR, "opencode.jsonc"),
  json: join(CONFIG_DIR, "opencode.json"),
};
/** The session's folder; its own config file is `PROJECT_FILE`. */
const PROJECT = join(FAKE_ROOT, "project");
const PROJECT_FILE = join(PROJECT, "opencode.json");
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
/**
 * The active login of each integration id, written as `{ id: value }`; a value's `resolveError`
 * is OpenCode's resolve error for that login.
 */
function asRows(logins: Record<string, Record<string, unknown>>): CredentialRow[] {
  return Object.entries(logins).map(([integrationId, { resolveError, ...value }]) => ({
    id: integrationId,
    integrationId,
    label: "",
    active: true,
    value,
    ...(typeof resolveError === "string" ? { resolveError } : {}),
  }));
}

/** The vendor's deciding login among `logins`, parsed as an API key. */
function parseLogins(spec: ApiKeyLoginSpec, logins: Record<string, Record<string, unknown>>) {
  return parseApiKeyLogin(spec, firstLoginRow(asRows(logins), spec.authKeys));
}

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
  for (const name of [
    ...ALL_ENV_VARS,
    "NOT_ALLOWED",
    "XDG_DATA_HOME",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_PROJECT_DISABLE",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
  ]) {
    delete process.env[name];
  }
  process.env.HOME = FAKE_ROOT;
  process.env.XDG_CONFIG_HOME = join(FAKE_ROOT, "config");
  mockConfigFiles({});
  mocks.readActiveCredentialRowsCached.mockReset().mockResolvedValue([]);
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
        await expect(resolveApiKeyFromEnvAndConfig(spec, PROJECT)).resolves.toEqual({
          key: `${name}-value`,
          source: `env:${name}`,
        });
        delete process.env[name];
      }
      for (const [index, alias] of expected.providerKeys.entries()) {
        const aliases = expected.providerKeys.slice(index);
        mockConfigFiles({ [TRUSTED.json]: legacyConfig(entriesFor(aliases, (id) => `${id}-key`)) });
        await expect(resolveApiKeyFromEnvAndConfig(spec, PROJECT)).resolves.toEqual({
          key: `${alias}-key`,
          source: "opencode.json",
        });
      }
    },
  );
});

describe("trusted config parsing", () => {
  const spec = API_KEY_VENDORS.deepseek;

  it("prefers opencode.jsonc over opencode.json in one folder", async () => {
    mockConfigFiles({
      [TRUSTED.jsonc]:
        '{ // preferred\n "provider": { "deepseek": { "options": { "apiKey": "jsonc-key" } } },\n}',
      [TRUSTED.json]: legacyConfig({ deepseek: "json-key" }),
    });
    await expect(resolveApiKey(spec, PROJECT)).resolves.toEqual({
      key: "jsonc-key",
      source: "opencode.jsonc",
    });
  });

  it("prefers the session folder's file over the global files", async () => {
    mockConfigFiles({
      [TRUSTED.jsonc]: legacyConfig({ deepseek: "global-key" }),
      [PROJECT_FILE]: legacyConfig({ deepseek: "project-key" }),
    });
    await expect(resolveApiKey(spec, PROJECT)).resolves.toEqual({
      key: "project-key",
      source: "opencode.json",
    });
  });

  it("leaves a project template naming another variable unresolved, with no config key", async () => {
    process.env.NOT_ALLOWED = "some-other-secret";
    mockConfigFiles({
      [TRUSTED.json]: legacyConfig({ deepseek: "global-key" }),
      [PROJECT_FILE]: legacyConfig({ deepseek: "{env:NOT_ALLOWED}" }),
    });
    // OpenCode uses the project's value there, so the global key is not the one it has.
    await expect(resolveApiKey(spec, PROJECT)).resolves.toBeNull();
  });

  it("a key the project clears falls through to the stored login; an env key still wins", async () => {
    mockConfigFiles({
      [TRUSTED.json]: legacyConfig({ deepseek: "global-key" }),
      [PROJECT_FILE]: JSON.stringify({ providers: { deepseek: { settings: { apiKey: null } } } }),
    });
    mocks.readActiveCredentialRowsCached.mockResolvedValue(
      asRows({ deepseek: { type: "api", key: "stored-key" } }),
    );
    await expect(resolveApiKeyLogin(spec, PROJECT)).resolves.toEqual({
      state: "configured",
      apiKey: "stored-key",
    });

    process.env.DEEPSEEK_API_KEY = "env-key";
    await expect(resolveApiKeyLogin(spec, PROJECT)).resolves.toEqual({
      state: "configured",
      apiKey: "env-key",
    });
  });

  it.each([
    ["apiKey: null", { options: { apiKey: null } }],
    ["a baseURL that is not a string", { options: { apiKey: "", baseURL: null } }],
    ["a timeout that is not a positive integer", { options: { apiKey: "", timeout: 0 } }],
    ["a header that is not a string", { options: { apiKey: "", headers: { "X-Retry": 1 } } }],
    ["env that is not a list", { env: "DEEPSEEK_API_KEY", options: { apiKey: "project-key" } }],
  ])("a legacy project entry OpenCode drops (%s) sets nothing", async (_label, entry) => {
    mockConfigFiles({
      [TRUSTED.json]: legacyConfig({ deepseek: "global-key" }),
      [PROJECT_FILE]: JSON.stringify({ provider: { deepseek: entry } }),
    });
    await expect(resolveApiKey(spec, PROJECT)).resolves.toEqual({
      key: "global-key",
      source: "opencode.json",
    });
  });

  it("a provider id the project clears leaves the vendor's next id as OpenCode has it", async () => {
    mockConfigFiles({
      [TRUSTED.json]: legacyConfig({ zai: "global-zai-key", "zai-coding-plan": "global-plan-key" }),
      [PROJECT_FILE]: legacyConfig({ zai: "" }),
    });
    await expect(resolveApiKeyFromEnvAndConfig(API_KEY_VENDORS.zai, PROJECT)).resolves.toEqual({
      key: "global-plan-key",
      source: "opencode.json",
    });
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
    const result = await resolveApiKey(spec, PROJECT);
    expect(result?.key ?? null).toBe(expected);
  });

  it("resolves a template naming the vendor's own second env var", async () => {
    // A vendor's own env var wins before config is read, so use a vendor whose
    // first env var is unset and whose template names its second one.
    process.env.ZAI_CODING_PLAN_API_KEY = "templated-key";
    mockConfigFiles({
      [TRUSTED.json]: legacyConfig({ zai: "{env:ZAI_CODING_PLAN_API_KEY}" }),
    });
    await expect(resolveApiKeyLogin(API_KEY_VENDORS.zai, PROJECT)).resolves.toEqual({
      state: "configured",
      apiKey: "templated-key",
    });
  });
});

describe("API key login vendors (a broken stored login is reported, not skipped)", () => {
  it.each(LOGIN_VENDORS)("%s: parses stored logins exactly", (_id, expected, spec) => {
    const withEntry = (entry: Record<string, unknown>) => ({ [expected.authKeys[0]]: entry });

    expect(parseLogins(spec, {})).toEqual({ state: "none" });
    expect(parseLogins(spec, withEntry({ type: { bad: true }, key: "k" }))).toEqual({
      state: "invalid",
      error: `${expected.displayName} auth entry present but type is missing or invalid`,
    });
    expect(parseLogins(spec, withEntry({ type: "oauth", key: "k" }))).toEqual({
      state: "invalid",
      error: unsupportedTypeError(expected, "oauth"),
    });
    expect(parseLogins(spec, withEntry({ type: "api", key: " " }))).toEqual({
      state: "invalid",
      error: `${expected.displayName} auth entry present but key is empty`,
    });
    expect(
      parseLogins(spec, withEntry({ type: "api", resolveError: "resolve_empty: no value" })),
    ).toEqual({
      state: "invalid",
      error: "OpenCode could not read this login: resolve_empty: no value",
    });
    for (const [index, authKey] of expected.authKeys.entries()) {
      const later = expected.authKeys.slice(index);
      expect(
        parseLogins(
          spec,
          entriesFor(later, (id) => ({ type: "api", key: ` ${id}-key ` })),
        ),
      ).toEqual({ state: "configured", apiKey: `${authKey}-key` });
    }
    if (expected.authKeys.length > 1) {
      expect(
        parseLogins(spec, {
          [expected.authKeys[0]]: { type: "oauth", key: "ignored" },
          [expected.authKeys[1]]: { type: "api", key: "later-key" },
        }),
      ).toEqual({ state: "invalid", error: unsupportedTypeError(expected, "oauth") });
    }
  });

  it("sanitizes, bounds, and falls back in the unsupported-type error", () => {
    const spec = API_KEY_VENDORS.zai;
    const withType = (type: string) => ({ "zai-coding-plan": { type } });
    expect(parseLogins(spec, withType("\u001b[31moauth\nretry\u001b[0m"))).toEqual({
      state: "invalid",
      error: 'Unsupported Z.ai auth type: "oauth retry"',
    });
    expect(parseLogins(spec, withType("\u001b[31m"))).toEqual({
      state: "invalid",
      error: 'Unsupported Z.ai auth type: "unknown"',
    });
    expect(parseLogins(spec, withType("x".repeat(130)))).toEqual({
      state: "invalid",
      error: `Unsupported Z.ai auth type: "${"x".repeat(120)}"`,
    });
  });

  it("uses a fixed OpenCode Go unsupported-type error that never echoes the login", async () => {
    const secret = "distinctive-go-secret";
    mocks.readActiveCredentialRowsCached.mockResolvedValue(
      asRows({ "opencode-go": { type: secret, key: secret } }),
    );
    const diagnostics = await getApiKeyLoginDiagnostics(API_KEY_VENDORS["opencode-go"], PROJECT);
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
      mocks.readActiveCredentialRowsCached.mockResolvedValue(
        asRows({ [expected.authKeys[0]]: { type: "oauth" } }),
      );
      await expect(resolveApiKeyLogin(spec, PROJECT)).resolves.toEqual({
        state: "configured",
        apiKey: `${expected.envVars[0]}-value`,
      });
      expect(mocks.readActiveCredentialRowsCached).not.toHaveBeenCalled();

      const lastEnvVar = expected.envVars.at(-1)!;
      for (const name of expected.envVars.slice(0, -1)) delete process.env[name];
      await expect(getApiKeyLoginDiagnostics(spec, PROJECT)).resolves.toEqual({
        state: "configured",
        source: `env:${lastEnvVar}`,
        checkedPaths: [`env:${lastEnvVar}`],
        credentialDatabasePaths: DB_PATHS,
      });
    },
  );

  it.each(LOGIN_VENDORS)(
    "%s: config aliases, global or project, win over a broken stored login",
    async (_id, expected, spec) => {
      mocks.readActiveCredentialRowsCached.mockResolvedValue(
        asRows({ [expected.authKeys[0]]: { type: "oauth" } }),
      );
      mockConfigFiles({
        [TRUSTED.jsonc]: legacyConfig({
          [expected.providerKeys[0]]: "{env:NOT_ALLOWED}",
          [expected.providerKeys.at(-1)!]: "alias-key",
        }),
      });
      await expect(getApiKeyLoginDiagnostics(spec, PROJECT)).resolves.toEqual({
        state: "configured",
        source: "opencode.jsonc",
        checkedPaths: [TRUSTED.jsonc],
        credentialDatabasePaths: DB_PATHS,
      });
      expect(mocks.readActiveCredentialRowsCached).not.toHaveBeenCalled();

      mockConfigFiles({ [PROJECT_FILE]: legacyConfig({ [expected.providerKeys[0]]: "k" }) });
      await expect(getApiKeyLoginDiagnostics(spec, PROJECT)).resolves.toEqual({
        state: "configured",
        source: "opencode.json",
        checkedPaths: [PROJECT_FILE],
        credentialDatabasePaths: DB_PATHS,
      });
      expect(mocks.readActiveCredentialRowsCached).not.toHaveBeenCalled();
    },
  );

  it.each(LOGIN_VENDORS)(
    "%s: reads cached stored logins with the vendor's ids",
    async (_id, expected, spec) => {
      mocks.readActiveCredentialRowsCached.mockResolvedValue(
        asRows({
          [expected.authKeys[0]]: { type: "api", key: "auth-key" },
        }),
      );
      await expect(resolveApiKeyLogin(spec, PROJECT)).resolves.toEqual({
        state: "configured",
        apiKey: "auth-key",
      });
      expect(mocks.readActiveCredentialRowsCached).toHaveBeenLastCalledWith(
        expectedLoginRead(expected, 5_000),
      );

      mocks.readActiveCredentialRowsCached.mockResolvedValue(
        asRows({ [expected.authKeys[0]]: { type: "oauth" } }),
      );
      await expect(getApiKeyLoginDiagnostics(spec, PROJECT)).resolves.toEqual({
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
    expect(parseLogins(API_KEY_VENDORS["kimi-code-plan-cn"], legacy)).toEqual({
      state: "configured",
      apiKey: "legacy-cn",
    });
    expect(parseLogins(API_KEY_VENDORS["kimi-code-plan-global"], legacy)).toEqual({
      state: "none",
    });

    process.env.MINIMAX_CHINA_CODING_PLAN_API_KEY = "china-key";
    await expect(
      resolveApiKeyLogin(API_KEY_VENDORS["minimax-coding-plan"], PROJECT),
    ).resolves.toEqual({
      state: "none",
    });
    await expect(
      resolveApiKeyLogin(API_KEY_VENDORS["minimax-china-coding-plan"], PROJECT),
    ).resolves.toEqual({ state: "configured", apiKey: "china-key" });
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
    mocks.readActiveCredentialRowsCached.mockImplementation(actual.readActiveCredentialRowsCached);
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
      await expect(resolveApiKeyLogin(spec, PROJECT)).resolves.toEqual({ state: "none" });
      expect(signedIn.connection.active.mock.calls).toEqual([["opencode-go"], ["opencode"]]);
      expect(signedIn.connection.resolve).not.toHaveBeenCalled();
    });
    await withLogins([workspaceKey], async () => {
      await expect(resolveApiKeyLogin(spec, PROJECT)).resolves.toEqual({
        state: "configured",
        apiKey: "workspace-key",
      });
    });
  });
});
