import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseStatusArgs, STATUS_USAGE } from "../src/lib/cli-status.js";

const { mockProviders, runtimeDirs } = vi.hoisted(() => ({
  mockProviders: [] as any[],
  runtimeDirs: {
    value: {
      dataDirs: [] as string[],
      configDirs: [] as string[],
      cacheDirs: [] as string[],
      stateDirs: [] as string[],
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

import { runCliStatusCommand } from "../src/lib/cli-status.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";

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

describe("parseStatusArgs", () => {
  it("returns help=true for --help", () => {
    const result = parseStatusArgs(["--help"]);
    expect(result).toEqual({ ok: true, help: true, json: false });
  });

  it("returns help=true for -h", () => {
    const result = parseStatusArgs(["-h"]);
    expect(result).toEqual({ ok: true, help: true, json: false });
  });

  it("returns help=true even when other flags present (-h --json)", () => {
    const result = parseStatusArgs(["-h", "--json"]);
    expect(result).toEqual({ ok: true, help: true, json: false });
  });

  it("returns help=true for --help with extra positional after", () => {
    const result = parseStatusArgs(["--help", "status"]);
    expect(result).toEqual({ ok: true, help: true, json: false });
  });

  it("parses --json flag", () => {
    const result = parseStatusArgs(["--json"]);
    expect(result).toEqual({ ok: true, help: false, json: true });
  });

  it("treats duplicate --json as idempotent, not error", () => {
    const result = parseStatusArgs(["--json", "--json"]);
    expect(result).toEqual({ ok: true, help: false, json: true });
  });

  it("parses --provider with space-separated value", () => {
    const result = parseStatusArgs(["--provider", "copilot"]);
    expect(result).toEqual({ ok: true, help: false, json: false, providerId: "copilot" });
  });

  it("parses --provider with equals form", () => {
    const result = parseStatusArgs(["--provider=copilot"]);
    expect(result).toEqual({ ok: true, help: false, json: false, providerId: "copilot" });
  });

  it("parses --provider and --json in any order", () => {
    const result1 = parseStatusArgs(["--provider=copilot", "--json"]);
    expect(result1).toEqual({ ok: true, help: false, json: true, providerId: "copilot" });
    const result2 = parseStatusArgs(["--json", "--provider", "copilot"]);
    expect(result2).toEqual({ ok: true, help: false, json: true, providerId: "copilot" });
  });

  it("rejects --provider specified twice", () => {
    const result = parseStatusArgs(["--provider", "copilot", "--provider", "openai"]);
    expect(result).toEqual({ ok: false, error: "Specify --provider only once." });
  });

  it("rejects --provider without value", () => {
    const result = parseStatusArgs(["--provider"]);
    expect(result).toEqual({ ok: false, error: "Missing value for --provider." });
  });

  it("rejects --provider with value starting with dash", () => {
    const result = parseStatusArgs(["--provider", "--json"]);
    expect(result).toEqual({ ok: false, error: "Missing value for --provider." });
  });

  it("rejects --provider= with empty value", () => {
    const result = parseStatusArgs(["--provider="]);
    expect(result).toEqual({ ok: false, error: "Missing value for --provider." });
  });

  it("rejects --threshold with descriptive error", () => {
    const result = parseStatusArgs(["--threshold", "50"]);
    expect(result).toEqual({
      ok: false,
      error: "--threshold is not supported by status. Use 'show --json --threshold' instead.",
    });
  });

  it("rejects --threshold= equals form too", () => {
    const result = parseStatusArgs(["--threshold=50"]);
    expect(result).toEqual({
      ok: false,
      error: "--threshold is not supported by status. Use 'show --json --threshold' instead.",
    });
  });

  it("rejects unknown flag", () => {
    const result = parseStatusArgs(["--unknown-flag"]);
    expect(result).toEqual({ ok: false, error: "Unknown option: --unknown-flag" });
  });

  it("rejects unexpected positional argument", () => {
    const result = parseStatusArgs(["extra-positional"]);
    expect(result).toEqual({ ok: false, error: "Unexpected argument: extra-positional" });
  });

  it("rejects bare double-dash", () => {
    const result = parseStatusArgs(["--"]);
    expect(result).toEqual({ ok: false, error: "Unknown option: --" });
  });

  it("returns default no-flag path for empty argv", () => {
    const result = parseStatusArgs([]);
    expect(result).toEqual({ ok: true, help: false, json: false });
  });

  it("STATUS_USAGE contains status command and provider flag", () => {
    expect(STATUS_USAGE).toContain("opencode-quota status");
    expect(STATUS_USAGE).toContain("--provider");
    expect(STATUS_USAGE).toContain("--json");
    expect(STATUS_USAGE).toContain("--help");
  });
});

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
    __resetQuotaStateForTests();
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mockProviders.length = 0;
    __resetQuotaStateForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("renders a status report containing the Quota Status header", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
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

    expect(code).toBe(0);
    expect(stdout.output).toContain("Quota Status");
    expect(stderr.output).toBe("");
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
  });

  it("rejects an unknown provider before probing", async () => {
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
  });

  it("filters availability to the requested --provider (canonical id)", async () => {
    const copilotProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    const openAiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(openAiProvider, copilotProvider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["copilot", "openai"] } },
      }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--provider", "copilot"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("copilot");
    expect(stderr.output).toBe("");
    expect(copilotProvider.isAvailable).toHaveBeenCalled();
  });

  it("resolves --provider synonym (claude -> anthropic)", async () => {
    const anthropicProvider = {
      id: "anthropic",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };
    mockProviders.push(anthropicProvider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["anthropic"] } },
      }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--provider", "claude"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("anthropic");
  });

  it("trims and lowercases --provider value", async () => {
    const copilotProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(copilotProvider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["copilot"] } },
      }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--provider", "  COPILot  "],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("copilot");
  });

  it("prints --help and exits zero", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--help"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("opencode-quota status");
    expect(stdout.output).toContain("--provider");
  });

  it("handles all providers throwing in isAvailable without crashing", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
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

    expect(code).toBe(0);
    expect(stdout.output).toContain("Quota Status");
  });

  it("renders report when enabledProviders is empty array", async () => {
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: [] } },
      }),
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

    expect(code).toBe(0);
    expect(stdout.output).toContain("Quota Status");
  });

  it("renders report when enabledProviders is auto", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: "auto" } },
      }),
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

    expect(code).toBe(0);
    expect(stdout.output).toContain("Quota Status");
  });

  it("outputs JSON with correct schema when --json is passed", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.output);
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("config");
    expect(parsed).toHaveProperty("providers");
    expect(parsed).toHaveProperty("pricing");
    expect(parsed).toHaveProperty("liveProbes");
    expect(Array.isArray(parsed.providers)).toBe(true);
    expect(Array.isArray(parsed.liveProbes)).toBe(true);
  });

  it("JSON output is pretty-printed with 2-space indent", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(stdout.output).toContain('  "version"');
    expect(stdout.output).toContain('  "providers"');
  });

  it("returns exit 1 when quota disabled and --json requested", async () => {
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: false } } }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Quota disabled in config");
  });

  it("returns exit 2 when --json and no providers available", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(2);
    const parsed = JSON.parse(stdout.output);
    expect(parsed.liveProbes).toEqual([]);
    expect(parsed.providers.every((p: any) => p.available === false)).toBe(true);
  });

  it("falls back to resolve(cwd) when not in a git worktree", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
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

    expect(code).toBe(0);
    expect(stdout.output).toContain("Quota Status");
  });

  it("prints error to stderr and exits 1 on unexpected failure", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);

    const runtimeContext = await import("../src/lib/quota-runtime-context.js");
    const spy = vi
      .spyOn(runtimeContext, "resolveQuotaRuntimeContext")
      .mockRejectedValue(new Error("boom"));

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliStatusCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    spy.mockRestore();

    expect(code).toBe(1);
    expect(stderr.output).toContain("Failed to show quota status");
  });
});
