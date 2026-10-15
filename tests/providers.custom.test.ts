import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
const runtime = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    configDirs: [join(runtime.root, "config")],
    dataDirs: [join(runtime.root, "data")],
    cacheDirs: [join(runtime.root, "cache")],
    stateDirs: [join(runtime.root, "state")],
  }),
  getOpencodeRuntimeDirs: () => ({
    configDir: join(runtime.root, "config"),
    dataDir: join(runtime.root, "data"),
    cacheDir: join(runtime.root, "cache"),
    stateDir: join(runtime.root, "state"),
  }),
}));
import { loadCustomQuotaDefinitions } from "../src/lib/quota-provider-config.js";
import { getCustomQuotaProviders } from "../src/providers/custom.js";
import { getQuotaProviderShape } from "../src/lib/provider-metadata.js";
import { loadConfig, createLoadConfigMeta } from "../src/lib/config.js";
import { fetchAllQuota } from "../src/gui/ipc/quota.js";
import { fetchQuotaProviderResult } from "../src/lib/quota-state.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { projectAccountingDetails } from "../src/lib/accounting-display.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
import { createQuotaProviderRuntimeContext } from "../src/lib/quota-runtime-context.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
let server: Server, url: string, configPath: string, requests: string[];
const ctx = {
  config: {
    requestTimeoutMs: 1000,
    enabledProviders: "auto",
    googleModels: [],
    alibabaCodingPlanTier: "lite",
    cursorPlan: "none",
  },
  client: {
    config: {
      providers: async () => ({ data: { providers: [] } }),
      get: async () => ({ data: {} }),
    },
  },
} as any;
const definition = (id: string, path: string) => ({
  id,
  providerId: "fixture",
  label: "Fixture",
  mode: "remote-api",
  url: url + path,
  apiKeyEnv: "CUSTOM_FIXTURE_KEY",
  format: "quota-v1",
});
const protocol = {
  version: "quota-v1",
  entries: [{ kind: "percent", name: "Daily", resultType: "quota", percentRemaining: 75 }],
};
async function save(definitions: unknown[]) {
  await writeFile(configPath, JSON.stringify({ quotaProviders: definitions }));
}
beforeEach(async () => {
  runtime.root = await mkdtemp(join(tmpdir(), "custom-quota-"));
  await mkdir(join(runtime.root, "config", "opencode-quota"), { recursive: true });
  await mkdir(join(runtime.root, "data"), { recursive: true });
  configPath = join(runtime.root, "config", "opencode-quota", "quota-toast.json");
  requests = [];
  vi.stubEnv("CUSTOM_FIXTURE_KEY", "fixture-secret");
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.headers.authorization !== "Bearer fixture-secret") {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: url + "/sink" });
      res.end();
      return;
    }
    if (req.url === "/slow") {
      res.writeHead(200);
      res.write("{");
      const timer = setTimeout(() => res.end(JSON.stringify(protocol).slice(1)), 1000);
      timer.unref();
      return;
    }
    if (req.url === "/huge") {
      res.end(" ".repeat(1024 * 1024) + JSON.stringify(protocol));
      return;
    }
    if (req.url === "/reflect") {
      res.end(
        JSON.stringify({
          version: "quota-v1",
          entries: [
            { kind: "value", name: "State", resultType: "status", value: "fixture-secret" },
          ],
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/raw"
          ? { balance: 12.5, used: 25 }
          : req.url === "/changed"
            ? { ...protocol, entries: [{ ...protocol.entries[0], percentRemaining: 50 }] }
            : protocol,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(runtime.root, { recursive: true, force: true });
});
describe("trusted custom remote providers", () => {
  it.each(["global", "auth"])(
    "uses trusted %s key fallback without workspace secrets",
    async (kind) => {
      vi.stubEnv("CUSTOM_FIXTURE_KEY", "");
      await save([definition("custom-fixture", "/quota")]);
      if (kind === "global")
        await writeFile(
          join(runtime.root, "config", "opencode.json"),
          JSON.stringify({ provider: { fixture: { options: { apiKey: "fixture-secret" } } } }),
        );
      else
        await writeFile(
          join(runtime.root, "data", "auth.json"),
          JSON.stringify({ fixture: { type: "api", key: "fixture-secret" } }),
        );
      const provider = getCustomQuotaProviders()[0];
      expect(await provider.isAvailable(ctx)).toBe(true);
      expect((await provider.fetch(ctx)).entries[0]).toMatchObject({ percentRemaining: 75 });
    },
  );
  it("filters configured model ids and safely diagnoses no credential", async () => {
    await save([{ ...definition("custom-model", "/quota"), modelIds: ["model-a"] }]);
    const provider = getCustomQuotaProviders()[0];
    expect(provider.matchesCurrentModel?.("fixture/model-a")).toBe(true);
    expect(provider.matchesCurrentModel?.("fixture/model-b")).toBe(false);
    vi.stubEnv("CUSTOM_FIXTURE_KEY", "");
    expect(await provider.isAvailable(ctx)).toBe(false);
    expect((await provider.fetch(ctx)).attempted).toBe(false);
    expect(requests).toEqual([]);
  });
  it("uses two different real HTTP mappings across shared surfaces without extra probes", async () => {
    const mapped = {
      ...definition("custom-json", "/raw"),
      format: "json-v1",
      adapter: {
        mappings: [
          {
            name: "Balance",
            resultType: "balance",
            unit: "USD",
            metric: { type: "value", valueType: "balance", value: { path: ["balance"] } },
          },
          {
            name: "Quota",
            resultType: "quota",
            unit: "requests",
            metric: { type: "used-limit", used: { path: ["used"] }, limit: { literal: 100 } },
          },
        ],
      },
    };
    await save([definition("custom-quota", "/quota"), mapped]);
    expect(getQuotaProviderShape("custom-json")?.authentication).toBe("external_api_key");
    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, { globalOnly: true });
    config.enabledProviders = ["custom-quota", "custom-json"];
    const desktop = await fetchAllQuota(config);
    expect(requests.sort()).toEqual(["/quota", "/raw"]);
    expect(desktop.accountingDetails?.some((row) => row.value === "USD 12.5")).toBe(true);
    expect(
      desktop.entries.some((row) => "percentRemaining" in row && row.percentRemaining === 75),
    ).toBe(true);
    const provider = getCustomQuotaProviders()[1];
    const sharedContext = createQuotaProviderRuntimeContext({
      client: ctx.client,
      config,
      session: {},
    });
    sharedContext.config.bypassCache = false;
    const result = await fetchQuotaProviderResult({ provider, ctx: sharedContext, ttlMs: 60000 });
    expect(requests).toHaveLength(2); // cache scope matches the desktop transaction
    const data = {
      entries: result.entries,
      errors: result.errors,
      accountingDetails: projectAccountingDetails(provider.id, result),
    };
    for (const text of [
      formatQuotaCommand(data),
      formatQuotaRows({ version: "fixture", ...data }),
      buildSidebarQuotaPanelLines({ data, config: DEFAULT_CONFIG }).join("\n"),
    ])
      expect(text).toContain("USD 12.5");
    expect(JSON.stringify(desktop)).not.toContain("fixture-secret");
  });
  it.each(["/redirect", "/slow", "/huge", "/reflect"])(
    "fails safely for %s with no redirected or reflected credential",
    async (path) => {
      await save([definition("custom-fixture", path)]);
      const started = performance.now();
      const result = await getCustomQuotaProviders()[0].fetch({
        ...ctx,
        config: { ...ctx.config, requestTimeoutMs: path === "/slow" ? 10 : 1000 },
      });
      if (path === "/slow") expect(performance.now() - started).toBeLessThan(500);
      expect(result.entries).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expect(requests).not.toContain("/sink");
    },
  );
  it("invalidates endpoint changes and fails closed after a definition is removed", async () => {
    await save([definition("custom-fixture", "/quota")]);
    const provider = getCustomQuotaProviders()[0];
    const a = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60000 });
    expect(a.entries[0]).toMatchObject({ percentRemaining: 75 });
    await save([definition("custom-fixture", "/changed")]);
    const b = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60000 });
    expect(b.entries[0]).toMatchObject({ percentRemaining: 50 });
    await save([]);
    expect(await provider.fetch(ctx)).toEqual({ attempted: false, entries: [], errors: [] });
    expect(requests).toEqual(["/quota", "/changed"]);
  });
  it("ignores workspace and merged SDK definitions and disables malformed global definitions", async () => {
    const workspace = join(runtime.root, "workspace");
    await mkdir(join(workspace, "opencode-quota"), { recursive: true });
    await writeFile(
      join(workspace, "opencode-quota", "quota-toast.json"),
      JSON.stringify({ quotaProviders: [definition("custom-untrusted", "/quota")] }),
    );
    expect(loadCustomQuotaDefinitions().definitions).toEqual([]);
    await loadConfig(
      {
        config: {
          get: async () => ({
            data: {
              experimental: {
                quotaToast: { quotaProviders: [definition("custom-sdk", "/quota")] },
              },
            },
          }),
        },
      } as any,
      undefined,
      { cwd: workspace },
    );
    expect(getCustomQuotaProviders()).toEqual([]);
    await save([{ ...definition("custom-invalid", "/quota"), script: "secret" }]);
    const meta = createLoadConfigMeta();
    await loadConfig(undefined, meta, { globalOnly: true });
    expect(meta.configIssues.some((issue) => issue.key === "quotaProviders")).toBe(true);
    expect(getCustomQuotaProviders()).toEqual([]);
    expect(requests).toEqual([]);
  });
});
