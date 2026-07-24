import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockProviders, runtimeDirs, statusData } = vi.hoisted(() => ({
  mockProviders: [] as any[],
  runtimeDirs: {
    value: {
      dataDirs: [] as string[],
      configDirs: [] as string[],
      cacheDirs: [] as string[],
      stateDirs: [] as string[],
    },
  },
  statusData: {
    value: null as null | {
      output: string;
      payload: Record<string, unknown>;
      hasComparableProviderData?: boolean;
    },
  },
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => runtimeDirs.value,
  getOpencodeRuntimeDirs: () => ({
    dataDir: runtimeDirs.value.dataDirs[0] ?? "/tmp/opencode-quota-cli-status-data",
    configDir: runtimeDirs.value.configDirs[0] ?? "/tmp/opencode-quota-cli-status-config",
    cacheDir: runtimeDirs.value.cacheDirs[0] ?? "/tmp/opencode-quota-cli-status-cache",
    stateDir: runtimeDirs.value.stateDirs[0] ?? "/tmp/opencode-quota-cli-status-state",
  }),
}));

vi.mock("../src/lib/quota-dialog-commands.js", () => ({
  buildStatusReportData: vi.fn(async () => {
    if (!statusData.value) {
      return { output: null, payload: null };
    }
    return {
      output: statusData.value.output,
      payload: statusData.value.payload,
      hasComparableProviderData: statusData.value.hasComparableProviderData ?? true,
    };
  }),
}));

import { runCliStatusCommand } from "../src/lib/cli-status.js";
import { buildStatusReportData } from "../src/lib/quota-dialog-commands.js";

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

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    version: "3.11.2",
    generatedAt: "2026-07-16T00:00:00.000Z",
    config: {
      configSource: "workspace",
      configPaths: ["/tmp/opencode.json"],
      enabledProviders: ["synthetic"],
      onlyCurrentModel: false,
      pricingSnapshotSource: "auto",
    },
    providers: [
      { id: "synthetic", enabled: true, available: true, matchesCurrentModel: undefined },
    ],
    pricing: {
      selection: "auto",
      activeSource: "bundled",
      snapshot: {
        source: "bundled",
        generatedAt: "2026-01-01T00:00:00.000Z",
        units: "USD per 1M tokens",
      },
      snapshotPath: "/tmp/pricing.json",
      refreshStatePath: "/tmp/pricing-state.json",
    },
    liveProbes: [{ id: "synthetic", ok: true }],
    ...overrides,
  };
}

describe("runCliStatusCommand", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-status-"));
    globalConfigDir = join(tempDir, "global-config", "opencode");
    workspaceDir = join(tempDir, "workspace");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    runtimeDirs.value = {
      dataDirs: [],
      configDirs: [globalConfigDir],
      cacheDirs: [join(tempDir, "cache")],
      stateDirs: [],
    };
    mockProviders.length = 0;
    statusData.value = null;
    vi.mocked(buildStatusReportData).mockClear();
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mockProviders.length = 0;
    statusData.value = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prints a plain-text Quota Status report and returns zero", async () => {
    statusData.value = {
      output: "Quota Status (opencode-quota v3.11.2)\ntoast:\n- enabledProviders: synthetic",
      payload: basePayload(),
    };
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Quota Status");
    expect(stdout.output).toContain("enabledProviders: synthetic");
    expect(stderr.output).toBe("");
    expect(buildStatusReportData).toHaveBeenCalledWith(
      expect.objectContaining({ providerFilterId: undefined }),
    );
  });

  it("--json emits a structured payload and returns zero when live probes exist", async () => {
    statusData.value = {
      output: "report text",
      payload: basePayload(),
    };
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stderr.output).toBe("");
    const parsed = JSON.parse(stdout.output);
    expect(parsed).toHaveProperty("version", "3.11.2");
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("config");
    expect(parsed).toHaveProperty("providers");
    expect(parsed).toHaveProperty("pricing");
    expect(parsed).toHaveProperty("liveProbes");
    expect(parsed.liveProbes).toHaveLength(1);
    expect(parsed.liveProbes[0]).toEqual({ id: "synthetic", ok: true });
  });

  it("--json exits 2 when there is no comparable provider data", async () => {
    statusData.value = {
      output: "report text",
      payload: basePayload({ liveProbes: [] }),
      hasComparableProviderData: false,
    };
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(2);
    expect(stderr.output).toBe("");
    // JSON still printed even on exit 2.
    const parsed = JSON.parse(stdout.output);
    expect(parsed.liveProbes).toEqual([]);
  });

  it("--json exits 2 when probes fail without producing quota entries", async () => {
    statusData.value = {
      output: "report text",
      payload: basePayload({ liveProbes: [{ id: "synthetic", ok: false }] }),
      hasComparableProviderData: false,
    };
    const stdout = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: { write: () => true } as any,
    });

    expect(code).toBe(2);
    expect(JSON.parse(stdout.output).liveProbes).toEqual([{ id: "synthetic", ok: false }]);
  });

  it("--json succeeds when a partial probe produced quota entries", async () => {
    statusData.value = {
      output: "report text",
      payload: basePayload({ liveProbes: [{ id: "synthetic", ok: false }] }),
      hasComparableProviderData: true,
    };

    const code = await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: { write: () => true } as any,
      stderr: { write: () => true } as any,
    });

    expect(code).toBe(0);
  });

  it("--provider filters the report to one provider", async () => {
    statusData.value = {
      output: "report text",
      payload: basePayload(),
    };
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--provider", "synthetic"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stderr.output).toBe("");
    expect(buildStatusReportData).toHaveBeenCalledWith(
      expect.objectContaining({ providerFilterId: "synthetic" }),
    );
  });

  it("resolves a case-insensitive provider synonym before filtering", async () => {
    statusData.value = {
      output: "report text",
      payload: basePayload(),
    };
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--provider", "  CLAUDE  "],
      cwd: workspaceDir,
      stdout: { write: () => true } as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stderr.output).toBe("");
    expect(buildStatusReportData).toHaveBeenCalledWith(
      expect.objectContaining({ providerFilterId: "anthropic" }),
    );
  });

  it("--provider --json forwards the provider filter and still emits JSON", async () => {
    statusData.value = {
      output: "report text",
      payload: basePayload(),
    };
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--json", "--provider", "synthetic"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(buildStatusReportData).toHaveBeenCalledWith(
      expect.objectContaining({ providerFilterId: "synthetic" }),
    );
    const parsed = JSON.parse(stdout.output);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed).not.toHaveProperty("providerFilterId");
  });

  it("rejects --threshold with a redirect to show --json --threshold", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--threshold", "50"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("--threshold is not supported by status");
    expect(stderr.output).toContain("opencode-quota show --json --threshold");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("rejects --threshold even when combined with --json", async () => {
    const stderr = createCaptureStream();
    const code = await runCliStatusCommand({
      argv: ["--json", "--threshold=10"],
      cwd: workspaceDir,
      stdout: { write: () => true } as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stderr.output).toContain("--threshold is not supported by status");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider before building the report", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--provider", "not-a-provider"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Unknown provider: not-a-provider");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("rejects a missing --provider value", async () => {
    const stderr = createCaptureStream();
    const code = await runCliStatusCommand({
      argv: ["--provider"],
      cwd: workspaceDir,
      stdout: { write: () => true } as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stderr.output).toContain("Missing value for --provider");
    expect(stderr.output).toContain("opencode-quota status");
  });

  it("rejects an unknown flag", async () => {
    const stderr = createCaptureStream();
    const code = await runCliStatusCommand({
      argv: ["--bogus"],
      cwd: workspaceDir,
      stdout: { write: () => true } as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stderr.output).toContain("Unknown option: --bogus");
    expect(stderr.output).toContain("opencode-quota status");
  });

  it("returns non-zero when quota is disabled in config", async () => {
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: false } } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Quota disabled in config");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("prints help and returns zero for --help", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--help"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stderr.output).toBe("");
    expect(stdout.output).toContain("opencode-quota status");
    expect(stdout.output).toContain("Exit codes:");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("returns non-zero when report building throws", async () => {
    vi.mocked(buildStatusReportData).mockRejectedValueOnce(new Error("boom"));
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: { write: () => true } as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stderr.output).toContain("Failed to generate quota status: boom");
  });
});
