import { mkdir, rm, writeFile } from "node:fs/promises";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaProvider, QuotaProviderContext } from "../src/lib/entries.js";

const root = "/tmp/opencode-quota-provider-account-cache-tests";
vi.mock("os", async () => ({
  ...(await vi.importActual<typeof import("os")>("os")),
  homedir: () => root,
}));
vi.mock("xdg-basedir", () => ({ xdgConfig: `${root}/config` }));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: [`${root}/data`],
    configDirs: [`${root}/config`],
    cacheDirs: [`${root}/cache`],
    stateDirs: [`${root}/state`],
  }),
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${root}/data`,
    configDir: `${root}/config`,
    cacheDir: `${root}/cache`,
    stateDir: `${root}/state`,
  }),
}));
const ctx = {
  config: {
    googleModels: [],
    alibabaCodingPlanTier: "lite",
    cursorPlan: "none",
    requestTimeoutMs: 1000,
  },
  client: {},
} as QuotaProviderContext;
const cases = [
  {
    id: "kilo",
    env: "KILO_API_KEY",
    header: "Authorization",
    prefix: "Bearer ",
    load: async () => (await import("../src/providers/kilo.js")).kiloProvider,
  },
  {
    id: "openrouter",
    env: "OPENROUTER_API_KEY",
    header: "Authorization",
    prefix: "Bearer ",
    load: async () => (await import("../src/providers/openrouter.js")).openRouterProvider,
  },
  {
    id: "chutes",
    env: "CHUTES_API_KEY",
    header: "Authorization",
    prefix: "Bearer ",
    load: async () => (await import("../src/providers/chutes.js")).chutesProvider,
  },
  {
    id: "synthetic",
    env: "SYNTHETIC_API_KEY",
    header: "Authorization",
    prefix: "Bearer ",
    load: async () => (await import("../src/providers/synthetic.js")).syntheticProvider,
  },
  {
    id: "nanogpt",
    env: "NANOGPT_API_KEY",
    header: "x-api-key",
    prefix: "",
    load: async () => (await import("../src/providers/nanogpt.js")).nanoGptProvider,
  },
  {
    id: "zai",
    env: "ZAI_API_KEY",
    header: "Authorization",
    prefix: "",
    load: async () => (await import("../src/providers/zai.js")).zaiProvider,
  },
  {
    id: "zhipu",
    env: "ZHIPU_API_KEY",
    header: "Authorization",
    prefix: "",
    load: async () => (await import("../src/providers/zhipu.js")).zhipuProvider,
  },
  {
    id: "kimi-for-coding",
    env: "KIMI_API_KEY",
    header: "Authorization",
    prefix: "Bearer ",
    load: async () => (await import("../src/providers/kimi-code.js")).kimiCodeProvider,
  },
  {
    id: "minimax-coding-plan",
    env: "MINIMAX_CODING_PLAN_API_KEY",
    header: "Authorization",
    prefix: "Bearer ",
    load: async () =>
      (await import("../src/providers/minimax-coding-plan.js")).minimaxCodingPlanProvider,
  },
  {
    id: "minimax-china-coding-plan",
    env: "MINIMAX_CHINA_CODING_PLAN_API_KEY",
    header: "Authorization",
    prefix: "Bearer ",
    load: async () =>
      (await import("../src/providers/minimax-coding-plan.js")).minimaxChinaCodingPlanProvider,
  },
  {
    id: "ollama-cloud",
    env: "OLLAMA_USAGE_COOKIE",
    header: "Cookie",
    prefix: "__Secure-session=",
    load: async () => (await import("../src/providers/ollama-cloud.js")).ollamaCloudProvider,
  },
];
async function prepare(provider: QuotaProvider) {
  expect(provider.cachePolicy?.kind).toBe("resolved-auth");
  if (provider.cachePolicy?.kind !== "resolved-auth") throw new Error("Missing account adapter");
  return provider.cachePolicy.prepare(ctx);
}
describe("production provider account cache adapters", () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
    await mkdir(`${root}/data`, { recursive: true });
    await mkdir(`${root}/config`, { recursive: true });
    for (const spec of cases) vi.stubEnv(spec.env, "");
    for (const name of [
      "MINIMAX_API_KEY",
      "NANO_GPT_API_KEY",
      "KIMI_CODE_API_KEY",
      "ZHIPU_CODING_PLAN_API_KEY",
      "ZAI_CODING_PLAN_API_KEY",
    ])
      vi.stubEnv(name, "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("fixture denial", { status: 401 })),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it.each(cases)(
    "$id captures the selected credential and separates token rotation",
    async (spec) => {
      vi.stubEnv(spec.env, "fixture-account-A");
      const provider = await spec.load();
      const a = await prepare(provider);
      expect(a).not.toBeNull();
      vi.stubEnv(spec.env, "fixture-account-B");
      const b = await prepare(provider);
      expect(b).not.toBeNull();
      expect(b!.identity).not.toBe(a!.identity);
      await a!.fetch();
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0);
      for (const [, init] of vi.mocked(fetch).mock.calls) {
        expect(new Headers(init?.headers).get(spec.header)).toBe(`${spec.prefix}fixture-account-A`);
      }
      vi.stubEnv(spec.env, "fixture-account-A");
      expect((await prepare(provider))!.identity).toBe(a!.identity);
      vi.stubEnv(spec.env, "");
      expect(await prepare(provider)).toBeNull();
    },
  );
  it.each(cases.filter((spec) => spec.id !== "ollama-cloud"))(
    "$id observes trusted-config removal and auth-file credential rotation",
    async (spec) => {
      const configPath = `${root}/config/opencode.json`;
      const authPath = `${root}/data/auth.json`;
      const authId =
        spec.id === "zai" ? "zai-coding-plan" : spec.id === "zhipu" ? "zhipu-coding-plan" : spec.id;
      await writeFile(
        configPath,
        JSON.stringify({ provider: { [spec.id]: { options: { apiKey: "fixture-global" } } } }),
      );
      await writeFile(
        authPath,
        JSON.stringify({ [authId]: { type: "api", key: "fixture-auth-A" } }),
      );
      const provider = await spec.load();
      const global = await prepare(provider);
      expect(global).not.toBeNull();
      await rm(configPath);
      const a = await prepare(provider);
      expect(a).not.toBeNull();
      expect(a!.identity).not.toBe(global!.identity);
      await writeFile(
        authPath,
        JSON.stringify({ [authId]: { type: "api", key: "fixture-auth-B" } }),
      );
      const b = await prepare(provider);
      expect(b).not.toBeNull();
      expect(b!.identity).not.toBe(a!.identity);
      await global!.fetch();
      for (const [, init] of vi.mocked(fetch).mock.calls) {
        expect(new Headers(init?.headers).get(spec.header)).toBe(`${spec.prefix}fixture-global`);
      }
    },
  );
  it("Copilot PAT target changes invalidate the cache even when the token is unchanged", async () => {
    const path = `${root}/config/copilot-quota-token.json`;
    await writeFile(
      path,
      JSON.stringify({ token: "ghp_fixture_token", tier: "business", organization: "first-org" }),
    );
    const provider = (await import("../src/providers/copilot.js")).copilotProvider;
    const first = await prepare(provider);
    await writeFile(
      path,
      JSON.stringify({ token: "ghp_fixture_token", tier: "business", organization: "second-org" }),
    );
    const second = await prepare(provider);
    expect(first).not.toBeNull();
    expect(second!.identity).not.toBe(first!.identity);
    await first!.fetch();
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("first-org");
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain("second-org");
  });
  it("all production providers explicitly choose scoped caching or uncached behavior", async () => {
    const { getProviders } = await import("../src/providers/registry.js");
    const { readCachedProviderResult } = await import("../src/lib/quota-state.js");
    for (const provider of getProviders()) {
      expect(["resolved-auth", "uncached"]).toContain(provider.cachePolicy?.kind);
      if (provider.cachePolicy?.kind === "uncached") {
        expect(await readCachedProviderResult({ provider, ctx, ttlMs: 60000 })).toEqual({
          hit: false,
        });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Copilot OAuth captures its credential before auth.json changes", async () => {
    const path = `${root}/data/auth.json`;
    await writeFile(
      path,
      JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-A" } }),
    );
    const provider = (await import("../src/providers/copilot.js")).copilotProvider;
    const a = await prepare(provider);
    await writeFile(
      path,
      JSON.stringify({ "github-copilot": { type: "oauth", access: "fixture-B" } }),
    );
    const b = await prepare(provider);
    expect(a).not.toBeNull();
    expect(b!.identity).not.toBe(a!.identity);
    await a!.fetch();
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("Authorization")).toContain(
      "fixture-A",
    );
  });
  it("OpenCode Go binds every workspace cookie and label to the prepared fetch", async () => {
    const path = `${root}/config/opencode-quota/opencode-go.json`;
    await mkdir(`${root}/config/opencode-quota`, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        workspaces: [
          { workspaceId: "workspace-A", authCookie: "cookie-A", label: "A" },
          { workspaceId: "workspace-B", authCookie: "cookie-B", label: "B" },
        ],
      }),
    );
    const provider = (await import("../src/providers/opencode-go.js")).opencodeGoProvider;
    const a = await prepare(provider);
    await writeFile(path, JSON.stringify({ workspaceId: "workspace-C", authCookie: "cookie-C" }));
    const b = await prepare(provider);
    expect(a).not.toBeNull();
    expect(b!.identity).not.toBe(a!.identity);
    await a!.fetch();
    expect(
      vi.mocked(fetch).mock.calls.map(([, init]) => new Headers(init?.headers).get("Cookie")),
    ).toEqual(["auth=cookie-A", "auth=cookie-B"]);
  });
  it("auth reads immediately observe login switches and logout inside the old TTL", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const path = `${root}/data/auth.json`;
    await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "account-A" } }));
    expect(await readAuthFileCached({ maxAgeMs: 60000 })).toMatchObject({
      openai: { access: "account-A" },
    });
    await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "account-B" } }));
    expect(await readAuthFileCached({ maxAgeMs: 60000 })).toMatchObject({
      openai: { access: "account-B" },
    });
    await rm(path);
    expect(await readAuthFileCached({ maxAgeMs: 60000 })).toBeNull();
  });
  it("OpenAI scopes the selected account header even when access tokens match", async () => {
    const authPath = `${root}/data/auth.json`;
    await writeFile(
      authPath,
      JSON.stringify({
        openai: { type: "oauth", access: "fixture-token", accountId: "account-A" },
      }),
    );
    const provider = (await import("../src/providers/openai.js")).openaiProvider;
    const a = await prepare(provider);
    await writeFile(
      authPath,
      JSON.stringify({
        openai: { type: "oauth", access: "fixture-token", accountId: "account-B" },
      }),
    );
    const b = await prepare(provider);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.identity).not.toBe(b!.identity);
    expect(a!.accountIdentity).toMatchObject({
      kind: "opaque",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(a!.accountIdentity).not.toEqual(b!.accountIdentity);
    await a!.fetch();
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("ChatGPT-Account-Id")).toBe(
      "account-A",
    );
  });
  it("OpenAI retains history identity through token rotation and leaves unidentified auth unknown", async () => {
    const authPath = `${root}/data/auth.json`;
    const writeAuth = (access: string, accountId?: string) =>
      writeFile(
        authPath,
        JSON.stringify({ openai: { type: "oauth", access, ...(accountId ? { accountId } : {}) } }),
      );
    const provider = (await import("../src/providers/openai.js")).openaiProvider;
    await writeAuth("fixture-token-A", "stable-account");
    const a = await prepare(provider);
    await writeAuth("fixture-token-B", "stable-account");
    const rotated = await prepare(provider);
    expect(rotated!.identity).not.toBe(a!.identity);
    expect(rotated!.accountIdentity).toEqual(a!.accountIdentity);
    expect(JSON.stringify(a!.accountIdentity)).not.toContain("stable-account");
    await writeAuth("fixture-token-B");
    expect((await prepare(provider))!.accountIdentity).toBeUndefined();
  });
});
