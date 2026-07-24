import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

import {
  createPluginTuiConfigInspection,
  createPricingModuleMock,
  seedDefaultPricingMocks,
} from "./helpers/plugin-test-harness.js";

const mocks = vi.hoisted(() => ({
  anthropicConfigured: false,
  kimiState: "none" as "none" | "configured",
  providers: [] as any[],
  runtimeDirs: {
    value: {
      dataDirs: [] as string[],
      configDirs: [] as string[],
      cacheDirs: [] as string[],
      stateDirs: [] as string[],
    },
  },
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  buildQuotaStatusReport: vi.fn(),
  inspectTuiConfig: vi.fn(),
  refreshGoogleTokensForAllAccounts: vi.fn(),
}));

vi.mock("../src/lib/anthropic.js", () => ({
  hasAnthropicCredentialsConfigured: vi.fn(async () => mocks.anthropicConfigured),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 30_000,
  resolveKimiAuthCached: vi.fn(async () => ({ state: mocks.kimiState })),
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mocks.providers,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => mocks.runtimeDirs.value,
  getOpencodeRuntimeDirs: () => ({
    dataDir: mocks.runtimeDirs.value.dataDirs[0],
    configDir: mocks.runtimeDirs.value.configDirs[0],
    cacheDir: mocks.runtimeDirs.value.cacheDirs[0],
    stateDir: mocks.runtimeDirs.value.stateDirs[0],
  }),
}));

vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

vi.mock("../src/lib/quota-status.js", () => ({
  buildQuotaStatusReport: mocks.buildQuotaStatusReport,
}));

vi.mock("../src/lib/tui-config-diagnostics.js", () => ({
  inspectTuiConfig: mocks.inspectTuiConfig,
}));

vi.mock("../src/lib/google.js", () => ({
  refreshGoogleTokensForAllAccounts: mocks.refreshGoogleTokensForAllAccounts,
}));

import { runCliStatusCommand } from "../src/lib/cli-status.js";

function createCaptureStream() {
  let output = "";
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      },
    },
    get output() {
      return output;
    },
  };
}

describe("status CLI integration", () => {
  let tempDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.anthropicConfigured = false;
    mocks.kimiState = "none";
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;

    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-status-integration-"));
    workspaceDir = join(tempDir, "workspace");
    const configDir = join(tempDir, "config");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mocks.runtimeDirs.value = {
      dataDirs: [join(tempDir, "data")],
      configDirs: [configDir],
      cacheDirs: [join(tempDir, "cache")],
      stateDirs: [join(tempDir, "state")],
    };

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["synthetic"],
          },
        },
      }),
      "utf8",
    );

    seedDefaultPricingMocks(mocks);
    mocks.buildQuotaStatusReport.mockResolvedValue(
      "Quota Status integration\nenabledProviders: synthetic",
    );
    mocks.inspectTuiConfig.mockResolvedValue(createPluginTuiConfigInspection(workspaceDir));
    mocks.providers.length = 0;
    mocks.providers.push({
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 75 }],
        errors: [],
      }),
    });
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mocks.providers.length = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(["anthropic", "kimi-for-coding"])(
    "recognizes locally authenticated %s without an explicit provider block",
    async (providerId) => {
      if (providerId === "anthropic") mocks.anthropicConfigured = true;
      if (providerId === "kimi-for-coding") mocks.kimiState = "configured";
      writeFileSync(
        join(workspaceDir, "opencode.json"),
        JSON.stringify({
          experimental: {
            quotaToast: {
              enabledProviders: [providerId],
            },
          },
        }),
        "utf8",
      );
      mocks.providers.length = 0;
      mocks.providers.push({
        id: providerId,
        isAvailable: vi.fn(async (ctx: any) =>
          (await ctx.resolveRuntimeProviderIds()).has(providerId),
        ),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: providerId, percentRemaining: 75 }],
          errors: [],
        }),
      });
      const stdout = createCaptureStream();

      const code = await runCliStatusCommand({
        argv: ["--json", "--provider", providerId],
        cwd: workspaceDir,
        stdout: stdout.stream as any,
        stderr: { write: () => true } as any,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.output).providers).toEqual([
        expect.objectContaining({ id: providerId, enabled: true, available: true }),
      ]);
    },
  );

  it("runs plain and JSON status through the real CLI client and status data builder", async () => {
    const plainStdout = createCaptureStream();
    const plainStderr = createCaptureStream();

    const plainCode = await runCliStatusCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: plainStdout.stream as any,
      stderr: plainStderr.stream as any,
    });

    expect(plainCode).toBe(0);
    expect(plainStderr.output).toBe("");
    expect(plainStdout.output).toContain("Quota Status integration");
    expect(plainStdout.output).toContain("enabledProviders: synthetic");

    const jsonStdout = createCaptureStream();
    const jsonStderr = createCaptureStream();
    const jsonCode = await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: jsonStdout.stream as any,
      stderr: jsonStderr.stream as any,
    });

    expect(jsonCode).toBe(0);
    expect(jsonStderr.output).toBe("");
    const payload = JSON.parse(jsonStdout.output);
    expect(payload.providers).toEqual([
      expect.objectContaining({ id: "synthetic", enabled: true, available: true }),
    ]);
    expect(payload.liveProbes).toEqual([{ id: "synthetic", ok: true }]);
    expect(mocks.providers[0].isAvailable).toHaveBeenCalledTimes(2);
    expect(mocks.providers[0].fetch).toHaveBeenCalledTimes(2);
    expect(mocks.buildQuotaStatusReport).toHaveBeenCalledTimes(2);
  });
});
