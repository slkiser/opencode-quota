import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { quotaAgentTools } from "../src/agent-tools.js";
import { bindCredentialSource, type CredentialRow } from "../src/lib/opencode-auth.js";
import { resolveQuotaProviderApiKey } from "../src/lib/quota-providers-remote.js";
import type { RemoteApiQuotaProviderDefinition } from "../src/lib/quota-providers.js";
import { createLiveSettings, loadSettings, settingsPath } from "../src/settings/index.js";

let root: string;
let openCodeProviderIds: string[];
let unbindCredentials: (() => void) | undefined;

/** The variable holding the gateway's key. */
const GATEWAY_VARIABLE = "MY_GATEWAY_API_KEY";

beforeEach(async () => {
  // Dots keep the folder name from looking like one long token.
  root = await mkdtemp(join(tmpdir(), "quota.agent.tools."));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv(GATEWAY_VARIABLE, "");
  openCodeProviderIds = ["my-gateway", "openrouter"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected fetch");
    }),
  );
});

afterEach(async () => {
  unbindCredentials?.();
  unbindCredentials = undefined;
  await rm(root, { recursive: true, force: true });
});

const GATEWAY = {
  id: "my-gateway-quota",
  providerId: "my-gateway",
  label: "My Gateway",
  mode: "remote-api",
  url: "https://gateway.example/v1/quota",
  format: "quota-v1",
  apiKeyEnv: GATEWAY_VARIABLE,
};

const OTHER = {
  id: "other-quota",
  providerId: "openrouter",
  mode: "remote-api",
  url: "https://other.example/quota",
  format: "quota-v1",
};

const FILE_WITH_COMMENTS = `// my note
{
  "version": 6,
  // keep me
  "providers": { "custom": [${JSON.stringify(OTHER)}] }
}
`;

type Answer = {
  /** The raw JSON text the agent reads. */
  text: string;
  ok?: boolean;
  message?: string;
  issues?: Array<{ key: string; message: string }>;
  notes?: string[];
  settings?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Runs one tool the way OpenCode does, with the settings a server holds, and reads its answer. */
async function call(name: string, input: unknown): Promise<Answer> {
  const settings = await createLiveSettings({ projectDir: root });
  try {
    const host = {
      openCodeProviderIds: async () => openCodeProviderIds,
      locationDirectory: root,
      settings,
    };
    const tool = quotaAgentTools(host).find((item) => item.name === name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    const { content } = await tool.execute(input);
    return { ...JSON.parse(content), text: content };
  } finally {
    settings.dispose();
  }
}

function writeSettings(text: string): void {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), text);
}

function settingsText(): string {
  return readFileSync(settingsPath(), "utf8");
}

/** The global opencode.json, with `provider.<id>.options.apiKey` for each entry. */
function saveOpenCodeKeys(keys: Record<string, string>): void {
  mkdirSync(join(root, "config"), { recursive: true });
  const provider = Object.fromEntries(
    Object.entries(keys).map(([providerId, apiKey]) => [providerId, { options: { apiKey } }]),
  );
  writeFileSync(join(root, "config", "opencode.json"), JSON.stringify({ provider }));
}

/** OpenCode's saved logins, as the server plugin reads them; `onRead` runs on every read. */
function bindLogins(logins: Record<string, string>, onRead = () => {}): void {
  unbindCredentials = bindCredentialSource({
    kind: "sqlite",
    async readRows({ integrationIds }) {
      onRead();
      return Object.entries(logins)
        .filter(([integrationId]) => integrationIds.includes(integrationId))
        .map(([integrationId, key]): CredentialRow => ({
          id: integrationId,
          integrationId,
          label: "",
          active: true,
          value: { type: "api", key },
        }));
    },
  });
}

/** The custom provider labels a quota_settings_get answer shows. */
function shownLabels(result: Answer): string[] {
  const custom = result.settings?.["providers.custom"] as { value: Array<{ label: string }> };
  return custom.value.map((definition) => definition.label);
}

const GATEWAY_WITHOUT_KEY_VARIABLE = Object.fromEntries(
  Object.entries(GATEWAY).filter(([field]) => field !== "apiKeyEnv"),
);

const LOCAL = {
  id: "my-local-quota",
  providerId: "my-gateway",
  mode: "local-estimate",
  windows: [{ id: "daily", type: "utc-day", requestLimit: 100 }],
};

/** What quota_provider_test answers for a switched-off provider. */
function switchedOff(): string {
  return (
    `Not tested: it is switched off. Ask the user to switch it on: "enabled": true in ` +
    `${settingsPath()}, or /quota_settings → Providers; then test it.`
  );
}

/** Names a caller may put where a property name goes: two secret shapes and a plain word. */
const CALLER_NAMES = [
  { shape: "hex", name: "9f86d081884c7d659a2feaa0c55ad015" },
  { shape: "random", name: "Zx9QmT4vLr8KpW2sNb7YhC3dFg6JkA1e" },
  { shape: "plain", name: "myownfieldname" },
];

const BALANCE_MAPPING = {
  resultType: "balance",
  name: "Balance",
  metric: { type: "value", valueType: "balance", value: { path: ["data", "balance"] } },
};

/** Each place an add or a set can hold a name the caller made up. */
const NAMED_DEFINITIONS: Array<{ where: string; definition: (name: string) => unknown }> = [
  { where: "at the top level", definition: (name) => ({ ...GATEWAY, [name]: 1 }) },
  { where: "after apiKey-", definition: (name) => ({ ...GATEWAY, [`apiKey-${name}`]: "x" }) },
  { where: "with a dot", definition: (name) => ({ ...GATEWAY, [`label.${name}`]: "x" }) },
  {
    where: "nested in the adapter",
    definition: (name) => ({
      ...GATEWAY,
      format: "json-v1",
      adapter: { [name]: 1, mappings: [BALANCE_MAPPING] },
    }),
  },
  {
    where: "in an array of mappings",
    definition: (name) => ({
      ...GATEWAY,
      format: "json-v1",
      adapter: { mappings: [{ ...BALANCE_MAPPING, [name]: 1 }] },
    }),
  },
  {
    where: "in an array of windows",
    definition: (name) => ({ ...LOCAL, windows: [{ ...LOCAL.windows[0], [name]: 1 }] }),
  },
  {
    where: "as a pricingModelMap key",
    definition: (name) => ({ ...LOCAL, pricingModelMap: { [name]: "nope/none" } }),
  },
];

const NAMED_PATCHES: Array<{ where: string; patch: (name: string) => unknown }> = [
  { where: "at the top level", patch: (name) => ({ [name]: 1 }) },
  { where: "in a group", patch: (name) => ({ providers: { checking: { [name]: 1 } } }) },
  { where: "in a nested group", patch: (name) => ({ providers: { cursor: { [name]: 1 } } }) },
  { where: "with a dot at the top level", patch: (name) => ({ [`checking.${name}`]: 1 }) },
  {
    where: "with a dot in a group",
    patch: (name) => ({ providers: { checking: { [`a.${name}`]: 1 } } }),
  },
  { where: "in an array", patch: (name) => ({ providers: { off: [{ [name]: 1 }] } }) },
];

/** The custom providers in the settings file, as the plugin loads them. */
async function savedProviders() {
  return (await loadSettings()).settings.providers.custom;
}

function answerWith(status: number, body: unknown) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const DAILY_QUOTA = {
  version: "quota-v1",
  entries: [
    {
      kind: "percent",
      name: "Daily",
      resultType: "quota",
      percentRemaining: 42,
      label: "Daily:",
      right: "58/100",
    },
  ],
};

describe("names the caller made up", () => {
  it.each(
    NAMED_DEFINITIONS.flatMap(({ where, definition }) =>
      CALLER_NAMES.map(({ shape, name }) => ({ where, shape, name, definition: definition(name) })),
    ),
  )("add never repeats a $shape name $where", async ({ name, definition }) => {
    const result = await call("quota_provider_add", { definition });

    expect(result.ok).toBe(false);
    expect(result.issues?.length).toBeGreaterThan(0);
    expect(result.text).not.toContain(name);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it.each(
    NAMED_PATCHES.flatMap(({ where, patch }) =>
      CALLER_NAMES.map(({ shape, name }) => ({ where, shape, name, patch: patch(name) })),
    ),
  )("set never repeats a $shape name $where", async ({ name, patch }) => {
    const result = await call("quota_settings_set", { patch });

    expect(result.ok).toBe(false);
    expect(result.issues?.length).toBeGreaterThan(0);
    expect(result.text).not.toContain(name);
    expect(existsSync(settingsPath())).toBe(false);
  });
});

describe("quota_settings_get", () => {
  it("lists each setting with its source and allowed values, and key variable names only", async () => {
    vi.stubEnv(GATEWAY_VARIABLE, "gateway-key-value-123");
    writeSettings(
      JSON.stringify({ words: { percent: "used" }, providers: { custom: [GATEWAY, OTHER] } }),
    );

    const result = await call("quota_settings_get", {});

    expect(result.file).toBe(settingsPath());
    expect(result.settings?.["words.percent"]).toEqual({
      value: "used",
      from: "file",
      allowed: 'one of: "left", "remaining", "bare", "used"',
    });
    expect(result.settings?.["words.reset"]).toMatchObject({ value: "smart", from: "default" });
    expect(result.settings?.["layout.barWidth"]).toEqual({
      value: "fill",
      from: "default",
      allowed: '"fill" or a whole number from 1 to 30',
    });
    expect(result.apiKeys).toEqual([
      { provider: "my-gateway-quota", apiKeyEnv: GATEWAY_VARIABLE, isSet: true },
      {
        provider: "other-quota",
        apiKeyEnv: null,
        readsFrom: `OpenCode's API key for provider "openrouter"`,
      },
    ]);
    expect(result.notes).toContainEqual(
      expect.stringMatching(/The user changes the other settings in \/quota_settings\.$/),
    );
    expect(result.text).not.toContain("gateway-key-value-123");
  });

  it("never shows a key the plugin can read, wherever the file holds it", async () => {
    vi.stubEnv("MY_SERVICE_TOKEN", "token-from-env-1");
    vi.stubEnv("ALIAS_VAR", "alias-key-value-77");
    saveOpenCodeKeys({ openrouter: "router-key-saved-in-opencode", other: "{env:ALIAS_VAR}" });
    bindLogins({ openrouter: "login-key-in-opencode-db" });
    const keys = [
      "token-from-env-1",
      "alias-key-value-77",
      "router-key-saved-in-opencode",
      "login-key-in-opencode-db",
    ];
    writeSettings(
      JSON.stringify({
        providers: {
          custom: [
            { ...OTHER, label: `${keys[0]} ${keys[1]}` },
            { ...GATEWAY, label: keys[3] },
          ],
          anthropic: { binaryPath: `/opt/${keys[2]}/claude` },
        },
      }),
    );

    const result = await call("quota_settings_get", {});

    expect(result.settings?.["providers.anthropic.binaryPath"]).toMatchObject({
      value: "/opt/[redacted]/claude",
    });
    for (const key of keys) expect(result.text).not.toContain(key);
  });

  it("never shows a key the plugin can read as a property name", async () => {
    vi.stubEnv("MY_SERVICE_TOKEN", "private-model-key-77");
    const local = { ...LOCAL, pricingModelMap: { "private-model-key-77": "openai/gpt-4o" } };
    writeSettings(JSON.stringify({ providers: { custom: [{ ...local, enabled: false }] } }));

    const result = await call("quota_settings_get", {});

    const custom = result.settings?.["providers.custom"] as { value: Array<typeof local> };
    expect(custom.value[0].pricingModelMap).toEqual({ "[redacted]": "openai/gpt-4o" });
    expect(result.text).not.toContain("private-model-key-77");
  });

  it("replaces each key shape in every answer, which stays valid JSON", async () => {
    const label = 'pk_test_Zx9QmT4vLr8K "and" Basic dXNlcjpwYXNzd29yZA== "and" Bearer a!b2c3d4';
    writeSettings(JSON.stringify({ providers: { custom: [{ ...OTHER, label }] } }));

    // `call` parses the answer, so an answer that is not valid JSON fails here.
    const result = await call("quota_settings_get", {});

    expect(result.problemsInFile).toBeUndefined();
    expect(shownLabels(result)).toEqual(['[redacted] "and" Basic [redacted] "and" [redacted]']);
  });
});

describe("quota_settings_set", () => {
  it("saves a patch into the settings file, keeps its comments and returns the diff", async () => {
    writeSettings(FILE_WITH_COMMENTS);

    const result = await call("quota_settings_set", {
      patch: { providers: { checking: { minIntervalMs: 600_000 } } },
    });

    expect(result).toMatchObject({
      ok: true,
      diff: [{ key: "providers.checking.minIntervalMs", before: 300_000, after: 600_000 }],
      message: "Saved.",
    });
    expect(settingsText()).toContain("// keep me");
    expect((await loadSettings()).settings.providers.checking.minIntervalMs).toBe(600_000);
    expect(existsSync(join(root, "config", "opencode.json"))).toBe(false);
  });

  it("reports removing a request timeout set to its default as a change, since unset it is each provider's own", async () => {
    writeSettings(JSON.stringify({ providers: { checking: { requestTimeoutMs: 5_000 } } }));

    const result = await call("quota_settings_set", {
      patch: { providers: { checking: { requestTimeoutMs: null } } },
    });

    expect(result).toMatchObject({
      ok: true,
      diff: [{ key: "providers.checking.requestTimeoutMs", before: 5_000, after: null }],
      message: "Saved.",
    });
    expect((await loadSettings()).fromFile).not.toContain("providers.checking.requestTimeoutMs");
  });

  it("never shows a saved key in the diff", async () => {
    saveOpenCodeKeys({ openrouter: "router-key-saved-in-opencode" });
    writeSettings(
      JSON.stringify({
        providers: { anthropic: { binaryPath: "/opt/router-key-saved-in-opencode/claude" } },
      }),
    );

    const result = await call("quota_settings_set", {
      patch: { providers: { anthropic: { binaryPath: null } } },
    });

    expect(result.diff).toEqual([
      { key: "providers.anthropic.binaryPath", before: "/opt/[redacted]/claude", after: "claude" },
    ]);
    expect(result.text).not.toContain("router-key-saved-in-opencode");
  });

  it("never shows a key saved in a project config file that counts for the session", async () => {
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "opencode.jsonc"),
      '{\n  // project keys\n  "provider": { "deepseek": { "options": { "apiKey": "project-key-in-dot-folder" } } },\n}\n',
    );
    writeSettings(
      JSON.stringify({
        providers: { anthropic: { binaryPath: "/opt/project-key-in-dot-folder/claude" } },
      }),
    );

    const result = await call("quota_settings_get", {});

    expect(result.settings?.["providers.anthropic.binaryPath"]).toMatchObject({
      value: "/opt/[redacted]/claude",
    });
    expect(result.text).not.toContain("project-key-in-dot-folder");
  });

  it.each([
    {
      name: "an unknown key, with the valid ones",
      patch: { providers: { checking: { minIntervalMz: 1 } } },
      message: /^unknown setting \(key 1\); valid in providers.checking: minIntervalMs,/,
    },
    {
      name: "an unknown group, with the ones agents may change",
      patch: { wordz: {} },
      message: /^unknown setting \(key 1 of the patch\); agents may change: providers$/,
    },
    {
      name: "a bad value",
      patch: { providers: { checking: { minIntervalMs: 0 } } },
      message: /^expected a number/,
    },
    ...["words", "sidebar", "colors", "layout", "system", "version"].map((group) => ({
      name: `the user's ${group}`,
      patch: { [group]: group === "version" ? 6 : { enabled: true } },
      message: new RegExp(`^the user changes ${group} in /quota_settings`),
    })),
    {
      name: "a dotted key for custom providers",
      patch: { "providers.custom": [{ ...GATEWAY, label: "sk-proj-abcdefghijklmnopqrstuv" }] },
      message: /^use nested objects, not dotted keys/,
    },
    {
      name: "a dotted reset of custom providers",
      patch: { "providers.custom": null },
      message: /^use nested objects, not dotted keys/,
    },
    {
      name: "a nested dotted key",
      patch: { providers: { "cursor.plan": "pro" } },
      message: /^a key with a dot is not read \(key 1\); nest it instead$/,
    },
    {
      name: "a key-like value",
      patch: { providers: { anthropic: { binaryPath: "sk-ant-api03-abcdefghijklmnopqrstuv" } } },
      message: /^looks like a key/,
    },
    {
      name: "custom providers",
      patch: { providers: { custom: [] } },
      message: /quota_provider_add and quota_provider_remove/,
    },
    {
      name: "a reset of every provider setting",
      patch: { providers: null },
      message: /quota_provider_add and quota_provider_remove/,
    },
  ])("rejects $name and saves nothing", async ({ patch, message }) => {
    writeSettings(FILE_WITH_COMMENTS);

    const result = await call("quota_settings_set", { patch });

    expect(result.ok).toBe(false);
    expect(result.issues?.[0]?.message).toMatch(message);
    expect(result.text).not.toMatch(/sk-proj|sk-ant/);
    expect(settingsText()).toBe(FILE_WITH_COMMENTS);
  });

  it("is in the settings the server holds once it answers", async () => {
    const settings = await createLiveSettings({ projectDir: root });
    try {
      const tools = quotaAgentTools({
        openCodeProviderIds: async () => [],
        locationDirectory: root,
        settings,
      });
      const set = tools.find((tool) => tool.name === "quota_settings_set");

      await set?.execute({ patch: { providers: { checking: { minIntervalMs: 600_000 } } } });

      expect(settings.current().settings.providers.checking.minIntervalMs).toBe(600_000);
    } finally {
      settings.dispose();
    }
  });
});

describe("quota_provider_add", () => {
  it.each([
    ...["xai-Zx9QmT4vLr8K", "Basic dXNlcjpwYXNzd29yZA==", "Bearer a!b2c3d4"].map((label) => ({
      name: label,
      definition: { ...GATEWAY, label },
      key: "definition.label",
    })),
    { name: "a key field", definition: { ...GATEWAY, apiKey: "abc" }, key: "definition" },
    {
      name: "a random token in the URL",
      definition: {
        ...GATEWAY,
        url: "https://gateway.example/v1/Zx9QmT4vLr8KpW2sNb7YhC3dFg6JkA1e/quota",
      },
      key: "definition.url",
    },
    {
      name: "a key where the variable name belongs",
      definition: { ...GATEWAY, apiKeyEnv: "sk-proj-abcdefghijklmnop1234" },
      key: "definition.apiKeyEnv",
    },
  ])("refuses $name and saves nothing", async ({ definition, key }) => {
    const result = await call("quota_provider_add", { definition });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ key, message: expect.stringMatching(/secret.*apiKeyEnv/) }]);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it.each([
    {
      name: "a model name",
      definition: { ...GATEWAY, modelIds: ["Qwen3-Coder-480B-A35B-Instruct-2507"] },
    },
    {
      name: "a model name in the URL",
      definition: {
        ...GATEWAY,
        url: "https://gateway.example/v1/models/Qwen3-Coder-480B-A35B-Instruct-2507/quota",
      },
    },
    {
      name: "a long model name without digits",
      definition: { ...GATEWAY, modelIds: ["llamaguardinstructionfinetunedmodel"] },
    },
    {
      name: "a camelCase field name in a JSON path",
      definition: {
        ...GATEWAY,
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "balance",
              name: "Balance",
              metric: {
                type: "value",
                valueType: "balance",
                value: { path: ["data", "AvailableBalanceUSD2024Total", "monkeyJsonPaths"] },
              },
            },
          ],
        },
      },
    },
    {
      name: "a long variable name",
      definition: { ...GATEWAY, apiKeyEnv: "MY_X1X2X3X4X5X6X7X8X9X0_API_KEY" },
    },
    { name: "a UUID", definition: { ...GATEWAY, label: "123e4567-e89b-12d3-a456-426614174000" } },
    {
      name: "an id and URL host that start like a key",
      definition: { ...GATEWAY, id: "pk-gateway-quota", url: "https://pk-gateway-quota.example/q" },
    },
  ])("saves $name", async ({ definition }) => {
    const result = await call("quota_provider_add", { definition });

    expect(result).toMatchObject({ ok: true, added: definition.id });
  });

  it.each(["sk-proj-abcdefghijklmnop1234", "Zx9QmT4vLr8KpW2sNb7YhC3dFg6JkA1e"])(
    "refuses a secret as a property name, without repeating it: %s",
    async (secret) => {
      const result = await call("quota_provider_add", {
        definition: { ...LOCAL, pricingModelMap: { [secret]: "openai/gpt-4o" } },
      });

      expect(result).toMatchObject({
        ok: false,
        issues: [{ key: "definition.pricingModelMap", message: expect.stringMatching(/secret/) }],
      });
      expect(result.text).not.toContain(secret);
      expect(existsSync(settingsPath())).toBe(false);
    },
  );

  it("rejects an invalid definition with the validator's message", async () => {
    writeSettings(FILE_WITH_COMMENTS);

    const result = await call("quota_provider_add", {
      definition: { ...GATEWAY, url: "http://gateway.example/quota" },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { key: "definition.url", message: "HTTPS is required except for loopback HTTP endpoints" },
    ]);
    expect(settingsText()).toBe(FILE_WITH_COMMENTS);
  });

  it.each([
    { name: "a provider with a key variable", definition: GATEWAY },
    { name: "a provider without one", definition: GATEWAY_WITHOUT_KEY_VARIABLE },
    { name: "a provider that asks to be on", definition: { ...GATEWAY, enabled: true } },
    { name: "a local estimate", definition: LOCAL },
  ])("saves $name switched off and fetches nothing", async ({ definition }) => {
    vi.stubEnv(GATEWAY_VARIABLE, "gateway-key");
    saveOpenCodeKeys({ "my-gateway": "gateway-key-saved-in-opencode" });
    const fetch = answerWith(200, DAILY_QUOTA);

    const result = await call("quota_provider_add", { definition });

    expect(result).toMatchObject({
      ok: true,
      added: definition.id,
      enabled: false,
      message: expect.stringContaining(
        `Ask the user to switch it on: "enabled": true in ${settingsPath()}, or /quota_settings`,
      ),
    });
    expect(result).not.toHaveProperty("test");
    expect(fetch).not.toHaveBeenCalled();
    expect(parse(settingsText()).providers.custom[0].enabled).toBe(false);
    expect((await savedProviders()).map((item) => item.enabled)).toEqual([false]);
  });

  it("answers the same whether or not OpenCode has a key saved for the provider", async () => {
    const without = await call("quota_provider_add", { definition: GATEWAY_WITHOUT_KEY_VARIABLE });
    await call("quota_provider_remove", { id: GATEWAY.id });
    saveOpenCodeKeys({ "my-gateway": "gateway-key-saved-in-opencode" });
    bindLogins({ "my-gateway": "gateway-login-in-opencode-db" });
    const withKey = await call("quota_provider_add", { definition: GATEWAY_WITHOUT_KEY_VARIABLE });

    expect(withKey.text).toBe(without.text);
    expect(withKey.ok).toBe(true);
  });

  it("hides the key of the provider it removes, in the answer that removes it", async () => {
    vi.stubEnv("REVIEW_ALIAS", "aliasvaluexyz");
    writeSettings(
      JSON.stringify({
        providers: { custom: [{ ...GATEWAY, id: "aliasvaluexyz", apiKeyEnv: "REVIEW_ALIAS" }] },
      }),
    );

    const result = await call("quota_provider_remove", { id: "aliasvaluexyz" });

    expect(result).toMatchObject({ ok: true, removed: "[redacted]" });
    expect(result.text).not.toContain("aliasvaluexyz");
  });

  it("adds a provider whose key is read only once the user switches it on", async () => {
    saveOpenCodeKeys({ "my-gateway": "gateway-key-saved-in-opencode" });

    await call("quota_provider_add", { definition: GATEWAY });
    const [off] = await savedProviders();
    expect(
      (await resolveQuotaProviderApiKey(off as RemoteApiQuotaProviderDefinition, root)).key,
    ).toBe(undefined);
    // The user switches it on in /quota_settings → Providers.
    const file = parse(settingsText());
    file.providers.custom[0].enabled = true;
    writeSettings(JSON.stringify(file));
    const [on] = await savedProviders();

    // Read the way a hand-written provider's key is: the variable, then OpenCode's key.
    expect(
      (await resolveQuotaProviderApiKey(on as RemoteApiQuotaProviderDefinition, root)).key,
    ).toBe("gateway-key-saved-in-opencode");
    vi.stubEnv(GATEWAY_VARIABLE, "gateway-key");
    expect(
      (await resolveQuotaProviderApiKey(on as RemoteApiQuotaProviderDefinition, root)).key,
    ).toBe("gateway-key");
  });

  it("never returns the key, even when the endpoint echoes it into a row id", async () => {
    writeSettings(JSON.stringify({ providers: { custom: [GATEWAY] } }));
    vi.stubEnv(GATEWAY_VARIABLE, "Echo-Me-Please-42");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        const key = init.headers.Authorization.replace("Bearer ", "");
        const body = {
          version: "quota-v1",
          entries: [{ kind: "percent", name: key, resultType: "quota", percentRemaining: 50 }],
        };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await call("quota_provider_test", { id: GATEWAY.id });

    expect(result).toMatchObject({ ok: true, rows: [{ percentRemaining: 50 }] });
    expect(result.text).not.toMatch(/echo.me.please.42/i);
  });

  it.each([
    { mode: "remote", definition: { ...GATEWAY, id: "echo-me-please-42" } },
    {
      mode: "local-estimate",
      definition: {
        id: "echo-me-please-42",
        providerId: "my-gateway",
        mode: "local-estimate",
        windows: [{ id: "daily", type: "utc-day", requestLimit: 100 }],
      },
    },
  ])("never puts a saved key into a $mode provider's row ids", async ({ definition }) => {
    vi.stubEnv("MY_SERVICE_TOKEN", "echo-me-please-42");
    vi.stubEnv(GATEWAY_VARIABLE, "gateway-key");
    answerWith(200, DAILY_QUOTA);
    writeSettings(JSON.stringify({ providers: { custom: [definition] } }));

    const result = await call("quota_provider_test", { id: "echo-me-please-42" });

    expect(result).toMatchObject({ ok: true, rows: [{ percentRemaining: expect.any(Number) }] });
    expect(result.text).not.toMatch(/echo.me.please.42/i);
  });

  it("adds a provider switched off and replaces it by id while keeping the others", async () => {
    writeSettings(FILE_WITH_COMMENTS);

    const added = await call("quota_provider_add", { definition: GATEWAY });

    expect(added).toMatchObject({
      ok: true,
      added: "my-gateway-quota",
      enabled: false,
      request: {
        url: "https://gateway.example/v1/quota",
        key: `${GATEWAY_VARIABLE}, else OpenCode's my-gateway key`,
        insecure: false,
      },
    });
    expect(added.notes).toBeUndefined();

    const replaced = await call("quota_provider_add", {
      definition: { ...GATEWAY, label: "Gateway Two" },
    });

    expect(replaced).toMatchObject({ ok: true, replaced: "my-gateway-quota" });
    expect((await savedProviders()).map((item) => [item.id, item.label, item.enabled])).toEqual([
      ["other-quota", "other-quota", undefined],
      ["my-gateway-quota", "Gateway Two", false],
    ]);
    expect(settingsText()).toContain("// keep me");
  });

  it("switches a provider off when it replaces one the user switched on", async () => {
    writeSettings(JSON.stringify({ providers: { custom: [{ ...GATEWAY, enabled: true }] } }));
    vi.stubEnv(GATEWAY_VARIABLE, "gateway-key");
    const fetch = answerWith(200, DAILY_QUOTA);

    const result = await call("quota_provider_add", {
      definition: { ...GATEWAY, url: "https://elsewhere.example/quota" },
    });
    const test = await call("quota_provider_test", { id: GATEWAY.id });

    expect(result).toMatchObject({ ok: true, replaced: GATEWAY.id, enabled: false });
    expect(await savedProviders()).toEqual([
      expect.objectContaining({ url: "https://elsewhere.example/quota", enabled: false }),
    ]);
    expect(test).toMatchObject({ ok: false, error: switchedOff() });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps every change when adds and a remove run at the same time", async () => {
    writeSettings(FILE_WITH_COMMENTS);
    const second = {
      ...GATEWAY,
      id: "second-quota",
      providerId: "second-gateway",
      apiKeyEnv: "SECOND_API_KEY",
    };

    const results = await Promise.all([
      call("quota_provider_add", { definition: GATEWAY }),
      call("quota_provider_add", { definition: second }),
      call("quota_provider_remove", { id: "other-quota" }),
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    const ids = (await loadSettings()).settings.providers.custom.map((item) => item.id);
    expect(ids.sort()).toEqual(["my-gateway-quota", "second-quota"]);
    expect(settingsText()).toContain("// keep me");
  });

  it("changes only its own entry, so comments inside the others stay", async () => {
    const file = FILE_WITH_COMMENTS.replace(
      '{"id":"other-quota"',
      '{\n// vendor note\n"id":"other-quota"',
    );
    writeSettings(file);

    const added = await call("quota_provider_add", { definition: GATEWAY });
    expect(settingsText()).toContain("// vendor note");
    const removed = await call("quota_provider_remove", { id: "my-gateway-quota" });

    expect([added.ok, removed.ok]).toEqual([true, true]);
    expect(settingsText()).toContain("// vendor note");
    expect((await loadSettings()).settings.providers.custom.map((item) => item.id)).toEqual([
      "other-quota",
    ]);
  });

  it("writes no filled-in defaults, and no label that only repeats the id", async () => {
    const { providerId: _, ...sameAsOpenCode } = { ...OTHER, id: "my-router" };
    writeSettings(JSON.stringify({ providers: { custom: [sameAsOpenCode] } }));

    const result = await call("quota_provider_add", {
      definition: { ...GATEWAY, label: GATEWAY.id },
    });

    expect(result.ok).toBe(true);
    expect(settingsText()).not.toContain('"label"');
    expect(settingsText()).not.toContain('"providerId": "my-router"');
    const loaded = await loadSettings();
    expect(loaded.issues).toEqual([]);
    expect(loaded.settings.providers.custom.map((item) => item.id)).toEqual([
      "my-router",
      "my-gateway-quota",
    ]);
  });

  it.each([
    ["quota_provider_add", { definition: GATEWAY }],
    ["quota_provider_remove", { id: "other-quota" }],
  ])("%s changes nothing while a custom provider in the file is invalid", async (name, input) => {
    const file = JSON.stringify({ providers: { custom: [OTHER, { id: "broken" }] } });
    writeSettings(file);

    const result = await call(name, input);

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Nothing was changed: fix the custom providers in /),
    });
    expect(result.issues?.length).toBeGreaterThan(0);
    expect(settingsText()).toBe(file);
  });

  it("changes nothing when the file turns invalid while it runs", async () => {
    writeSettings(FILE_WITH_COMMENTS);
    const invalid = FILE_WITH_COMMENTS.replace('"format":"quota-v1"', '"format":"quota-v9"');
    // Reading OpenCode's logins happens after the tool starts; the user saves a typo meanwhile.
    bindLogins({}, () => writeSettings(invalid));

    const result = await call("quota_provider_add", { definition: GATEWAY });

    expect(result.ok).toBe(false);
    expect(settingsText()).toBe(invalid);
  });

  it("says why a saved provider would not show", async () => {
    openCodeProviderIds = ["openrouter"];

    const result = await call("quota_provider_add", { definition: GATEWAY });

    expect(result.ok).toBe(true);
    expect(result.notes).toEqual([expect.stringMatching(/OpenCode has no provider "my-gateway"/)]);
    expect((await savedProviders()).map((item) => item.id)).toEqual(["my-gateway-quota"]);
  });
});

describe("quota_provider_test and quota_provider_remove", () => {
  it.each(["quota_provider_test", "quota_provider_remove"])(
    "%s names the known ids for an unknown one",
    async (name) => {
      writeSettings(FILE_WITH_COMMENTS);

      const result = await call(name, { id: "my-own-id-word" });

      expect(result).toMatchObject({
        ok: false,
        message: "No custom provider has that id.",
        ids: ["other-quota"],
      });
      expect(result.text).not.toContain("my-own-id-word");
      expect(settingsText()).toBe(FILE_WITH_COMMENTS);
    },
  );

  it("tests a saved provider and returns the fetch error", async () => {
    writeSettings(JSON.stringify({ providers: { custom: [GATEWAY] } }));
    vi.stubEnv(GATEWAY_VARIABLE, "gateway-key");
    answerWith(401, { error: "unauthorized" });

    const result = await call("quota_provider_test", { id: "my-gateway-quota" });

    expect(result).toMatchObject({ id: "my-gateway-quota", ok: false, error: "HTTP 401" });
  });

  it("tests a hand-written provider without the field: it is on and uses OpenCode's key", async () => {
    writeSettings(FILE_WITH_COMMENTS);
    saveOpenCodeKeys({ openrouter: "router-key-saved-in-opencode" });
    const fetch = answerWith(200, DAILY_QUOTA);

    const result = await call("quota_provider_test", { id: "other-quota" });

    expect(result).toMatchObject({ id: "other-quota", ok: true, rows: [{ percentRemaining: 42 }] });
    expect(fetch).toHaveBeenCalledWith(
      OTHER.url,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer router-key-saved-in-opencode" }),
      }),
    );
    expect(result.text).not.toContain("router-key-saved-in-opencode");
  });

  it.each([
    { mode: "remote", definition: { ...GATEWAY, enabled: false } },
    { mode: "local-estimate", definition: { ...LOCAL, enabled: false } },
  ])(
    "refuses to test a switched-off $mode provider and fetches nothing",
    async ({ definition }) => {
      writeSettings(JSON.stringify({ providers: { custom: [definition] } }));
      vi.stubEnv(GATEWAY_VARIABLE, "gateway-key");
      const fetch = answerWith(200, DAILY_QUOTA);

      const result = await call("quota_provider_test", { id: definition.id });

      expect(result).toMatchObject({ id: definition.id, ok: false, error: switchedOff() });
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(join(root, "state", "opencode", "opencode-quota", "quota-providers"))).toBe(
        false,
      );
    },
  );

  it("reads no login of a switched-off provider, not even to hide it", async () => {
    const off = { ...GATEWAY, providerId: "off-gateway", enabled: false };
    writeSettings(JSON.stringify({ providers: { custom: [off] } }));
    const asked: string[] = [];
    unbindCredentials = bindCredentialSource({
      kind: "sqlite",
      async readRows({ integrationIds }) {
        asked.push(...integrationIds);
        return [];
      },
    });

    const result = await call("quota_provider_test", { id: off.id });

    expect(result).toMatchObject({ ok: false, error: switchedOff() });
    expect(asked).toContain("my-gateway");
    expect(asked).not.toContain("off-gateway");
  });

  it("removes one provider and keeps the others and the comments", async () => {
    writeSettings(
      FILE_WITH_COMMENTS.replace(
        `${JSON.stringify(OTHER)}`,
        `${JSON.stringify(OTHER)}, ${JSON.stringify(GATEWAY)}`,
      ),
    );

    const result = await call("quota_provider_remove", { id: "my-gateway-quota" });

    expect(result).toMatchObject({
      ok: true,
      removed: "my-gateway-quota",
      remaining: ["other-quota"],
      message: "Removed.",
    });
    expect((await loadSettings()).settings.providers.custom.map((item) => item.id)).toEqual([
      "other-quota",
    ]);
    expect(settingsText()).toContain("// keep me");
  });
});
