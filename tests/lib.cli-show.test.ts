import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    dataDir: runtimeDirs.value.dataDirs[0] ?? "/tmp/opencode-quota-cli-show-data",
    configDir: runtimeDirs.value.configDirs[0] ?? "/tmp/opencode-quota-cli-show-config",
    cacheDir: runtimeDirs.value.cacheDirs[0] ?? "/tmp/opencode-quota-cli-show-cache",
    stateDir: runtimeDirs.value.stateDirs[0] ?? "/tmp/opencode-quota-cli-show-state",
  }),
}));

import { runCliShowCommand } from "../src/lib/cli-show.js";
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

describe("runCliShowCommand", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-show-"));
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

  it("renders a compact quota glance and returns zero when quota rows are available", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic Weekly", percentRemaining: 75 }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["synthetic"],
            showSessionTokens: true,
          },
        },
      }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Synthetic Weekly");
    expect(stdout.output).toContain("75%");
    expect(stderr.output).toBe("");
    expect(provider.fetch).toHaveBeenCalledOnce();
  });

  it("normalizes --provider aliases and uses the provider as an invocation override", async () => {
    const copilotProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Copilot", percentRemaining: 50 }],
        errors: [],
      }),
    };
    const openAiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({ attempted: true, entries: [], errors: [] }),
    };
    mockProviders.push(openAiProvider, copilotProvider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabledProviders: ["openai"] } } }),
      "utf8",
    );

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider=github-copilot"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Copilot");
    expect(copilotProvider.fetch).toHaveBeenCalledOnce();
    expect(openAiProvider.fetch).not.toHaveBeenCalled();
    expect(stderr.output).toBe("");
  });

  it("rejects an unknown provider before probing providers", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider", "not-a-provider"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Unknown provider: not-a-provider");
    expect(provider.isAvailable).not.toHaveBeenCalled();
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("rejects missing provider values", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Missing value for --provider");
    expect(stderr.output).toContain("opencode-quota show");
  });

  it("returns non-zero when quota is disabled in config", async () => {
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: false } } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Quota disabled in config");
  });

  it("renders explicit unavailable provider output but returns non-zero", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider", "copilot"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toContain("Copilot: Unavailable (not detected)");
    expect(stderr.output).toBe("");
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("prefers the git worktree root over a nested cwd for config loading", async () => {
    const nestedDir = join(workspaceDir, "packages", "app");
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".git"));
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: false } } }),
      "utf8",
    );
    writeFileSync(
      join(nestedDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: true } } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: nestedDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Quota disabled in config");
  });

  it("resolves relative OPENCODE_CONFIG_DIR from the worktree root", async () => {
    const nestedDir = join(workspaceDir, "packages", "app");
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".git"));
    mkdirSync(join(workspaceDir, ".opencode"), { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    writeFileSync(
      join(workspaceDir, ".opencode", "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: false } } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: nestedDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Quota disabled in config");
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("renders Copilot and Gemini CLI success rows in standalone show", async () => {
    const copilotProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Copilot", group: "Copilot (personal)", label: "Quota:", right: "0/300", percentRemaining: 100 }],
        errors: [],
      }),
    };
    const geminiCliProvider = {
      id: "google-gemini-cli",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Gemini Pro", group: "Gemini CLI", label: "Gemini Pro:", right: "840 left", percentRemaining: 84 }],
        errors: [],
      }),
    };
    mockProviders.push(copilotProvider, geminiCliProvider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["copilot", "google-gemini-cli"],
            formatStyle: "allWindows",
          },
        },
      }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Copilot");
    expect(stdout.output).toContain("Gemini CLI");
    expect(copilotProvider.fetch).toHaveBeenCalledOnce();
    expect(geminiCliProvider.fetch).toHaveBeenCalledOnce();
    expect(stderr.output).toBe("");
  });

  it("uses root-level OpenCode provider ids for standalone provider availability", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn(async (ctx: any) => {
        const response = await ctx.client.config.providers();
        return response.data.providers.some((item: { id: string }) => item.id === "github-copilot");
      }),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Copilot", percentRemaining: 88 }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ provider: { "github-copilot": {} } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Copilot");
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(stderr.output).toBe("");
  });

  // ──────────────────────────────────────────────
  //  --json / --threshold tests
  // ──────────────────────────────────────────────

  it("--json outputs valid JSON to stdout with cached provider data", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 75 }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );

    // Run non-JSON show first to populate the cache.
    const textOut = createCaptureStream();
    const textErr = createCaptureStream();
    const textCode = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: textOut.stream as any,
      stderr: textErr.stream as any,
    });
    expect(textCode).toBe(0);
    expect(provider.fetch).toHaveBeenCalledOnce();

    // Now run --json (reads from cache).
    const jsonOut = createCaptureStream();
    const jsonErr = createCaptureStream();
    const jsonCode = await runCliShowCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: jsonErr.stream as any,
    });

    expect(jsonCode).toBe(0);
    expect(jsonErr.output).toBe("");

    const parsed = JSON.parse(jsonOut.output);
    expect(parsed).toHaveProperty("version", 1);
    expect(parsed).toHaveProperty("exportedAt");
    expect(parsed).toHaveProperty("fromCache", true);
    expect(parsed).toHaveProperty("cacheAgeSeconds");
    expect(parsed.providers).toHaveProperty("synthetic");
    expect(parsed.providers.synthetic.status).toBe("ok");
    expect(parsed.providers.synthetic.entries[0].name).toBe("Synthetic");
    expect(parsed.providers.synthetic.entries[0].percentRemaining).toBe(75);
    expect(parsed.providers.synthetic.entries[0].unlimited).toBe(false);
    expect(provider.fetch).toHaveBeenCalledTimes(1); // still only called from text path
  });

  it("--json reads from cache only and returns unavailable when no cache exists", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 100 }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );

    // Run --json WITHOUT populating cache first → all unavailable, no fetch.
    const jsonOut = createCaptureStream();
    const jsonErr = createCaptureStream();
    const jsonCode = await runCliShowCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: jsonErr.stream as any,
    });

    expect(jsonCode).toBe(0);
    expect(jsonErr.output).toBe("");
    const parsed = JSON.parse(jsonOut.output);
    expect(parsed.providers.synthetic.status).toBe("unavailable");
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [80, "50", 0],
    [30, "50", 1],
  ])(
    "--threshold exits %s when a provider is at %s%% remaining",
    async (percentRemaining, threshold, expectedCode) => {
      const provider = {
        id: "synthetic",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ name: "Synthetic", percentRemaining }],
          errors: [],
        }),
      };
      mockProviders.push(provider);
      writeFileSync(
        join(workspaceDir, "opencode.json"),
        JSON.stringify({
          experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
        }),
        "utf8",
      );

      // Populate cache.
      await runCliShowCommand({
        argv: [],
        cwd: workspaceDir,
        stdout: { write: () => true } as any,
        stderr: { write: () => true } as any,
      });

      const jsonCode = await runCliShowCommand({
        argv: ["--json", "--threshold", threshold],
        cwd: workspaceDir,
        stdout: { write: () => true } as any,
        stderr: { write: () => true } as any,
      });

      expect(jsonCode).toBe(expectedCode);
    },
  );

  it("--threshold exits 2 when no provider is ok", async () => {
    // Provider that is unavailable (no cache populated).
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 100 }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );

    // Run --threshold WITHOUT populating cache → all unavailable.
    const jsonOut = createCaptureStream();
    const jsonCode = await runCliShowCommand({
      argv: ["--json", "--threshold", "10"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: { write: () => true } as any,
    });

    expect(jsonCode).toBe(2);
  });

  it("--threshold exits 2 when cached ok providers have no percentRemaining values", async () => {
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", kind: "value", value: "$42", label: "Usage:" }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );

    await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: { write: () => true } as any,
      stderr: { write: () => true } as any,
    });

    const jsonCode = await runCliShowCommand({
      argv: ["--json", "--threshold", "10"],
      cwd: workspaceDir,
      stdout: { write: () => true } as any,
      stderr: { write: () => true } as any,
    });

    expect(jsonCode).toBe(2);
  });

  it("--json --provider copilot only includes the copilot key", async () => {
    const copilotProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Copilot", percentRemaining: 90 }],
        errors: [],
      }),
    };
    const syntheticProvider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 50 }],
        errors: [],
      }),
    };
    mockProviders.push(copilotProvider, syntheticProvider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["copilot", "synthetic"] } },
      }),
      "utf8",
    );

    // Populate cache for both providers.
    await runCliShowCommand({ argv: [], cwd: workspaceDir, stdout: { write: () => true } as any, stderr: { write: () => true } as any });

    const jsonOut = createCaptureStream();
    const jsonCode = await runCliShowCommand({
      argv: ["--json", "--provider", "copilot"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: { write: () => true } as any,
    });

    expect(jsonCode).toBe(0);
    const parsed = JSON.parse(jsonOut.output);
    expect(Object.keys(parsed.providers)).toEqual(["copilot"]);
    expect(parsed.providers.copilot.status).toBe("ok");
  });

  it("reports unknown flag with --json as error on stderr with exit code 1", async () => {
    const jsonOut = createCaptureStream();
    const jsonErr = createCaptureStream();

    const jsonCode = await runCliShowCommand({
      argv: ["--json", "--bogus-flag"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: jsonErr.stream as any,
    });

    expect(jsonCode).toBe(1);
    expect(jsonErr.output).toContain("Unknown option: --bogus-flag");
    expect(jsonErr.output).toContain("opencode-quota show");
  });

  it("--threshold validates input and requires --json", async () => {
    const run = async (argv: string[]) => {
      const stdout = createCaptureStream();
      const stderr = createCaptureStream();
      const code = await runCliShowCommand({
        argv,
        cwd: workspaceDir,
        stdout: stdout.stream as any,
        stderr: stderr.stream as any,
      });
      return { code, stderr: stderr.output };
    };

    // Invalid value
    let result = await run(["--json", "--threshold", "abc"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold must be a positive finite number");

    // Zero
    result = await run(["--json", "--threshold", "0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold must be a positive finite number");

    // Missing value
    result = await run(["--json", "--threshold"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing value for --threshold");

    // Without --json
    result = await run(["--threshold", "5"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold requires --json");
  });

});
