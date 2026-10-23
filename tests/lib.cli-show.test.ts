import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_IDS as CONFIG_PROVIDER_IDS } from "../src/settings/schema.js";

import { answer, percentRow } from "./helpers/fake-answers.js";

const { authMocks, mockProviders } = vi.hoisted(() => ({
  authMocks: {
    anthropicConfigured: false,
    kimiGlobalState: "none" as "none" | "configured",
    kimiCnState: "none" as "none" | "configured",
  },
  mockProviders: [] as any[],
}));

vi.mock("../src/lib/anthropic.js", () => ({
  hasAnthropicCredentialsConfigured: vi.fn(async () => authMocks.anthropicConfigured),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api-key-resolver.js")>();
  return {
    ...actual,
    resolveApiKeyLogin: vi.fn(async (spec: unknown) => ({
      state:
        spec === actual.API_KEY_VENDORS["kimi-code-plan-global"]
          ? authMocks.kimiGlobalState
          : spec === actual.API_KEY_VENDORS["kimi-code-plan-cn"]
            ? authMocks.kimiCnState
            : "none",
    })),
  };
});

import { snapshotFilePath } from "../src/core/persist.js";
import { loadProviderSource } from "../src/core/provider-source.js";
import { createQuotaStore } from "../src/core/store.js";
import {
  createCliQuotaClient,
  runCliShowCommand,
  runCliStatusCommand,
} from "../src/lib/cli-show.js";
import { describePriceList } from "../src/lib/modelsdev-pricing.js";
import {
  clearCredentialRowCacheForTests,
  getCredentialSourceDiagnostics,
  readCredentialRows,
} from "../src/lib/opencode-auth.js";
import { loadSettings } from "../src/settings/index.js";
import { writeCredentialDatabase } from "./helpers/credential-database.js";

/** The Z.ai provider; its check answers with one 75% weekly row. */
function zai() {
  return {
    id: "zai",
    cachePolicy: { kind: "account-neutral" as const },
    isAvailable: vi.fn().mockResolvedValue(true),
    fetch: vi.fn(async () => answer({ name: "Z.ai", rows: [percentRow("weekly", "Weekly", 75)] })),
  };
}

let tempDir: string;
let globalConfigDir: string;
let workspaceDir: string;
let savedConfigDir: string | undefined;

async function run(command: "show" | "status", argv: string[]) {
  const output = { stdout: "", stderr: "" };
  const capture = (name: "stdout" | "stderr") => ({
    write: (chunk: string | Uint8Array) => {
      output[name] += String(chunk);
      return true;
    },
  });
  const runCommand = command === "show" ? runCliShowCommand : runCliStatusCommand;
  const code = await runCommand({
    argv,
    cwd: workspaceDir,
    stdout: capture("stdout"),
    stderr: capture("stderr"),
    providers: () => mockProviders,
  });
  return { code, ...output };
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(globalConfigDir, "opencode-quota"), { recursive: true });
  writeFileSync(
    join(globalConfigDir, "opencode-quota", "settings.jsonc"),
    JSON.stringify(settings),
    "utf8",
  );
}

beforeEach(() => {
  authMocks.anthropicConfigured = false;
  authMocks.kimiGlobalState = "none";
  authMocks.kimiCnState = "none";
  savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OPENCODE_CONFIG_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-"));
  globalConfigDir = join(tempDir, "global-config", "opencode");
  workspaceDir = join(tempDir, "workspace");
  mkdirSync(globalConfigDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  // OpenCode's folders by its own rules: `$XDG_<KIND>_HOME/opencode`.
  vi.stubEnv("XDG_CONFIG_HOME", join(tempDir, "global-config"));
  vi.stubEnv("XDG_DATA_HOME", join(tempDir, "data"));
  vi.stubEnv("XDG_CACHE_HOME", join(tempDir, "cache"));
  vi.stubEnv("XDG_STATE_HOME", join(tempDir, "state"));
  vi.stubEnv("OPENCODE_DB", join(tempDir, "opencode.db"));
  mockProviders.length = 0;
  writeSettings({
    providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
  });
});

afterEach(() => {
  if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
  else delete process.env.OPENCODE_CONFIG_DIR;
  mockProviders.length = 0;
  clearCredentialRowCacheForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createCliQuotaClient", () => {
  it("synthesizes offline Kimi runtime ids independently by region", async () => {
    writeFileSync(join(workspaceDir, "opencode.json"), "{}", "utf8");

    const client = () =>
      createCliQuotaClient({ directory: workspaceDir, anthropicBinaryPath: "claude" });
    const unauthenticated = await client().config.providers();
    expect(unauthenticated.data?.providers).toEqual([]);

    authMocks.anthropicConfigured = true;
    authMocks.kimiCnState = "configured";
    const cnOnly = await client().config.providers();
    expect(cnOnly.data?.providers).toEqual([{ id: "anthropic" }, { id: "kimi-code-plan-cn" }]);

    authMocks.kimiGlobalState = "configured";
    const bothRegions = await client().config.providers();
    expect(bothRegions.data?.providers).toEqual([
      { id: "anthropic" },
      { id: "kimi-code-plan-global" },
      { id: "kimi-code-plan-cn" },
    ]);
  });

  it("lists the providers of every OpenCode config file that counts for its folder", async () => {
    vi.stubEnv("HOME", tempDir);
    // The global opencode.json counts next to an opencode.jsonc.
    writeFileSync(join(globalConfigDir, "opencode.json"), '{ "provider": { "deepseek": {} } }');
    writeFileSync(join(globalConfigDir, "opencode.jsonc"), '{ "theme": "dark" }');
    // So do a parent folder's file and the folder's own .opencode folder.
    writeFileSync(join(tempDir, "opencode.json"), '{ "provider": { "openai": {}, }, }');
    mkdirSync(join(workspaceDir, ".opencode"));
    writeFileSync(
      join(workspaceDir, ".opencode", "opencode.jsonc"),
      '{\n  // dot folder\n  "provider": { "zai": {} },\n}\n',
    );

    const client = createCliQuotaClient({ directory: workspaceDir, anthropicBinaryPath: "claude" });

    await expect(client.config.providers()).resolves.toEqual({
      data: { providers: [{ id: "deepseek" }, { id: "openai" }, { id: "zai" }] },
    });
  });
});

describe("show and status arguments", () => {
  it.each([
    ["show", ["--provider"], "Missing value for --provider"],
    ["show", ["--json", "--bogus-flag"], "Unknown option: --bogus-flag"],
    ["show", ["--json", "--threshold", "abc"], "--threshold must be a positive finite number"],
    ["show", ["--json", "--threshold", "0"], "--threshold must be a positive finite number"],
    ["show", ["--json", "--threshold"], "Missing value for --threshold"],
    ["show", ["--threshold", "5"], "--threshold requires --json"],
    ["status", ["--provider"], "Missing value for --provider"],
    ["status", ["--bogus"], "Unknown option: --bogus"],
    [
      "status",
      ["--threshold", "50"],
      "--threshold is not supported by status. For threshold exit codes, use: opencode-quota show --json --threshold",
    ],
    ["status", ["--json", "--threshold=10"], "--threshold is not supported by status"],
  ] as const)("%s %j exits 1 with the error and the usage", async (command, argv, error) => {
    const provider = zai();
    mockProviders.push(provider);

    const result = await run(command, [...argv]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(error);
    expect(result.stderr).toContain(`opencode-quota ${command}`);
    expect(provider.isAvailable).not.toHaveBeenCalled();
  });

  it.each(["show", "status"] as const)(
    "%s rejects an unknown provider before checking any provider",
    async (command) => {
      const provider = zai();
      mockProviders.push(provider);

      const result = await run(command, ["--provider", "not-a-provider"]);

      expect(result).toEqual({ code: 1, stdout: "", stderr: "Unknown provider: not-a-provider\n" });
      expect(provider.isAvailable).not.toHaveBeenCalled();
      expect(provider.fetch).not.toHaveBeenCalled();
    },
  );

  it("prints help without starting a report", async () => {
    const provider = zai();
    mockProviders.push(provider);
    const show = await run("show", ["--help"]);
    expect(show.code).toBe(0);
    expect(show.stderr).toBe("");
    expect(show.stdout).toContain("opencode-quota show");
    expect(show.stdout).not.toContain("OpenCode running");
    expect(show.stdout).not.toMatch(/exit code 3/i);

    const status = await run("status", ["-h"]);
    expect(status.code).toBe(0);
    expect(status.stderr).toBe("");
    expect(status.stdout).toContain("opencode-quota status");
    expect(status.stdout).toContain("Exit codes:");
    expect(provider.isAvailable).not.toHaveBeenCalled();
  });
});

describe.each(["show", "status"] as const)("%s report frame", (command) => {
  it("checks the providers with the price list and refresh age the settings choose", async () => {
    writeSettings({
      providers: {
        off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)),
        pricing: { source: "bundled", autoRefreshDays: 3 },
      },
    });
    const seen: Array<{ source: string; maxAgeMs: number }> = [];
    const provider = zai();
    provider.fetch.mockImplementation(async () => {
      const { selection, health } = await describePriceList();
      seen.push({ source: selection, maxAgeMs: health.maxAgeMs });
      return answer();
    });
    mockProviders.push(provider);

    await run(command, []);

    expect(seen).toEqual([{ source: "bundled", maxAgeMs: 3 * 24 * 60 * 60 * 1000 }]);
  });
});

describe("runCliShowCommand", () => {
  it("reads logins from OpenCode's database, read-only, only while the command runs", async () => {
    const databasePath = join(tempDir, "opencode.db");
    writeCredentialDatabase(databasePath, [
      {
        id: "cred_zai",
        integrationId: "zai",
        active: 1,
        updated: 1,
        value: { type: "key", key: "zai-key" },
      },
    ]);
    const databaseBefore = readFileSync(databasePath);
    let rowsDuringRun: unknown;
    let sourceDuringRun: unknown;
    const provider = zai();
    provider.fetch.mockImplementation(async () => {
      rowsDuringRun = await readCredentialRows(["zai"]);
      sourceDuringRun = getCredentialSourceDiagnostics();
      return answer({ name: "Z.ai", rows: [percentRow("weekly", "Weekly", 75)] });
    });
    mockProviders.push(provider);

    const result = await run("show", []);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(rowsDuringRun).toEqual([
      {
        id: "cred_zai",
        integrationId: "zai",
        label: "default",
        active: true,
        value: { type: "api", key: "zai-key" },
      },
    ]);
    expect(sourceDuringRun).toMatchObject({ state: "bound", kind: "sqlite" });
    expect(getCredentialSourceDiagnostics().state).toBe("unbound");
    expect(readFileSync(databasePath).equals(databaseBefore)).toBe(true);
  });

  it("normalizes --provider aliases and checks only that provider", async () => {
    const copilotProvider = {
      id: "copilot",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValue(
          answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 50)] }),
        ),
    };
    const openAiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(answer()),
    };
    mockProviders.push(openAiProvider, copilotProvider);
    writeSettings({
      providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["openai"].includes(id)) },
    });

    const result = await run("show", ["--provider=github-copilot"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Copilot");
    expect(copilotProvider.fetch).toHaveBeenCalledOnce();
    expect(openAiProvider.fetch).not.toHaveBeenCalled();
    expect(result.stderr).toBe("");
  });

  it("uses root-level OpenCode provider ids for standalone provider availability", async () => {
    const provider = {
      id: "copilot",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn(async (ctx: any) => {
        const response = await ctx.client.config.providers();
        return response.data.providers.some((item: { id: string }) => item.id === "github-copilot");
      }),
      fetch: vi
        .fn()
        .mockResolvedValue(
          answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 88)] }),
        ),
    };
    mockProviders.push(provider);
    writeSettings({});
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ provider: { "github-copilot": {} } }),
      "utf8",
    );

    const result = await run("show", []);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Copilot");
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(result.stderr).toBe("");
  });

  it("--json prints the saved quota as JSON and passes --threshold on", async () => {
    const provider = zai();
    mockProviders.push(provider);

    const json = await run("show", ["--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).providers.zai.status).toBe("unavailable");
    // Nothing saved yet, so no provider is ok.
    expect((await run("show", ["--json", "--threshold", "10"])).code).toBe(2);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("--json outputs the quota OpenCode saved last", async () => {
    const provider = zai();
    mockProviders.push(provider);

    // OpenCode's store checks the providers and saves the snapshot.
    const loaded = await loadSettings();
    const store = createQuotaStore({
      source: () =>
        loadProviderSource({
          client: { config: { providers: async () => ({ data: { providers: [] } }) } },
          workspaceRoot: workspaceDir,
          locationDirectory: workspaceDir,
          settings: () => loaded,
          providers: () => mockProviders,
        }),
      file: snapshotFilePath(),
    });
    await store.refresh({ reason: "manual" });
    await store.dispose();
    expect(provider.fetch).toHaveBeenCalledOnce();

    const result = await run("show", ["--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("version", 3);
    expect(parsed).toHaveProperty("exportedAt");
    expect(parsed).toHaveProperty("fromCache", true);
    expect(parsed).toHaveProperty("cacheAgeSeconds");
    expect(parsed.providers.zai.status).toBe("ok");
    expect(parsed.providers.zai.entries[0].name).toBe("Z.ai Weekly");
    expect(parsed.providers.zai.entries[0].percentRemaining).toBe(75);
    expect(parsed.providers.zai.entries[0].renderType).toBe("percent");
    expect(parsed.providers.zai.entries[0]).not.toHaveProperty("unlimited");
    expect(provider.fetch).toHaveBeenCalledTimes(1); // only OpenCode's store asked it
  });
});

describe("runCliStatusCommand", () => {
  it("prints the text report, or JSON with --json", async () => {
    mockProviders.push(zai());

    const text = await run("status", []);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^# Quota Status/u);

    const json = await run("status", ["--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toHaveProperty("version", "6");
  });

  it.each([
    [["--provider", "zai"], "zai"],
    [["--provider", "  CLAUDE  "], "anthropic"],
  ])("%j filters the report to %s", async (argv, providerId) => {
    mockProviders.push(zai(), { ...zai(), id: "anthropic" });
    const result = await run("status", argv);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(new RegExp(`\nproviders:\n- ${providerId}: [^\n]+\n\n`, "u"));
  });

  it("--provider --json lists only that provider and still emits JSON", async () => {
    mockProviders.push(zai(), { ...zai(), id: "anthropic" });
    const result = await run("status", ["--json", "--provider", "zai"]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.providers.map((provider: { id: string }) => provider.id)).toEqual(["zai"]);
    expect(parsed).not.toHaveProperty("providerFilterId");
  });

  it("builds the report with the database login source bound and unbinds it afterwards", async () => {
    let sourceDuringRun: unknown;
    const provider = zai();
    provider.fetch.mockImplementation(async () => {
      sourceDuringRun = getCredentialSourceDiagnostics();
      return answer();
    });
    mockProviders.push(provider);

    const result = await run("status", []);

    expect(result.code).toBe(0);
    expect(sourceDuringRun).toMatchObject({ state: "bound", kind: "sqlite" });
    expect(getCredentialSourceDiagnostics().state).toBe("unbound");
  });

  it("returns non-zero when report building throws", async () => {
    mockProviders.push({
      get id(): string {
        throw new Error("boom");
      },
    });
    const result = await run("status", []);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Failed to generate quota status: boom");
    expect(getCredentialSourceDiagnostics().state).toBe("unbound");
  });
});
