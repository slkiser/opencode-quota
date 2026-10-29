import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/** Whether a Claude install folder holds `claude`; every other path is the real file system. */
const fsMocks = vi.hoisted(() => ({ existsSync: vi.fn((_path: string) => false) }));

/** Reads of Claude's credentials file; every other file is read for real. */
const readCredentialsFile = vi.hoisted(() => vi.fn());

import { execFile } from "child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProviderSource } from "../src/core/provider-source.js";
import { createQuotaStore } from "../src/core/store.js";
import {
  anthropicLoginsIdentity,
  buildClaudeCommandInvocation,
  clearAnthropicDiagnosticsCacheForTests,
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  parseOAuthUsageResponse,
  parseUsageResponse,
  readAnthropicLogins,
  resolveAnthropicOAuth,
} from "../src/lib/anthropic.js";
import {
  bindCredentialSource,
  type CredentialRow,
  createIntegrationCredentialSource,
} from "../src/lib/opencode-auth.js";
import { __resetResolvedAuthIdentityForTests } from "../src/lib/resolved-auth-identity.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { defaultSettings } from "../src/settings/index.js";
import fableWeeklyUsage from "./fixtures/anthropic/fable-weekly.sanitized.json";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import { useProviderWorld } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

vi.mock("fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("fs/promises")>();
  return {
    ...fs,
    readFile: (path: string, ...rest: unknown[]) =>
      String(path).endsWith(".credentials.json")
        ? readCredentialsFile(path, ...rest)
        : fs.readFile(path, ...(rest as [BufferEncoding])),
  };
});

vi.mock("fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("fs")>();
  return {
    ...fs,
    existsSync: (path: string) =>
      String(path).endsWith("claude") ? fsMocks.existsSync(path) : fs.existsSync(path),
  };
});

const world = useProviderWorld();
const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";

type ExecSequenceStep = {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  errorMessage?: string;
  killed?: boolean;
};

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const NO_QUOTA_MESSAGE =
  "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.";
const CREDENTIALS_FILE = join(".claude", ".credentials.json");
const CLAUDE_INSTALL_FOLDER_CANDIDATES = [
  join(homedir(), ".claude", "local", "claude"),
  join(homedir(), ".local", "bin", "claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];
const CLI_VERSION: ExecSequenceStep = { stdout: "claude 1.2.3\n" };
const CLI_AUTHENTICATED: ExecSequenceStep = { stdout: JSON.stringify({ authenticated: true }) };
const CLI_MISSING: ExecSequenceStep = { code: "ENOENT", errorMessage: "spawn claude ENOENT" };
const USAGE_10_20 = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } };
const ENOENT_ERROR = Object.assign(new Error("missing credentials"), { code: "ENOENT" });

const execFileMock = vi.mocked(execFile);
const readFileMock = readCredentialsFile;
/** The reply of each usage request, in order. */
const fetchResponseMock = vi.fn<() => Promise<Response>>();
const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
  fetchResponseMock(),
);
const originalProcessPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function mockExecSequence(steps: ExecSequenceStep[]): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    const step = steps.shift();
    if (!step) {
      throw new Error("Unexpected execFile call");
    }

    const error =
      step.code === undefined
        ? null
        : Object.assign(new Error(step.errorMessage ?? `Command failed: ${String(step.code)}`), {
            code: step.code,
            killed: step.killed ?? false,
          });

    callback(error, step.stdout ?? "", step.stderr ?? "");
    return {} as never;
  });
}

function mockResponse(status: number, body: unknown, retryAfter?: string): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });
}

/** A reply whose body fails when read; `stall` keeps it pending until the request is aborted. */
function unreadableResponse(status: number, options: { retryAfter?: string; stall?: boolean }) {
  return (_url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            if (options.stall) {
              init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            } else {
              controller.error(new Error("body stalled"));
            }
          },
        }),
        {
          status,
          headers: options.retryAfter === undefined ? {} : { "Retry-After": options.retryAfter },
        },
      ),
    );
}

function cliQuotaStatus(fiveHourUsed: number, sevenDayUsed: number): ExecSequenceStep {
  return {
    stdout: JSON.stringify({
      authenticated: true,
      quota: {
        five_hour: { used_percentage: fiveHourUsed },
        seven_day: { used_percentage: sevenDayUsed },
      },
    }),
  };
}

function keychainToken(accessToken: string): ExecSequenceStep {
  return { stdout: JSON.stringify({ claudeAiOauth: { accessToken } }) };
}

function authenticatedWithoutQuotaSteps(count: number): ExecSequenceStep[] {
  return Array.from({ length: count }, () => [CLI_VERSION, CLI_AUTHENTICATED]).flat();
}

/** One OpenCode Claude login in the temp `opencode.db`. */
function mockOpenCodeLogin(access: string | undefined, expires?: number): void {
  world.storeLogins([
    {
      id: "login-1",
      integrationId: "anthropic",
      active: 1,
      updated: 1,
      value: { type: "oauth", access, ...(expires === undefined ? {} : { expires }) },
    },
  ]);
}

/** Linux, a signed-in Claude CLI without quota windows, and a credentials-file token. */
function setUpCredentialsFileFallback(probes: number, accessToken = "oauth-access-token"): void {
  setProcessPlatform("linux");
  mockExecSequence(authenticatedWithoutQuotaSteps(probes));
  readFileMock.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken } }));
}

function useFakeNow(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
}

function bearerTokensSent(): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => new Headers(init?.headers).get("Authorization") ?? "",
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  execFileMock.mockReset();
  fsMocks.existsSync.mockReset();
  fsMocks.existsSync.mockReturnValue(false);
  readFileMock.mockReset();
  __resetResolvedAuthIdentityForTests();
  fetchMock.mockClear();
  fetchResponseMock.mockReset();
  vi.unstubAllGlobals();
  clearAnthropicDiagnosticsCacheForTests();
  if (originalProcessPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalProcessPlatformDescriptor);
  }
});

describe("usage response parsing", () => {
  it.each([
    [
      "the current five_hour / seven_day response shape",
      {
        five_hour: { utilization: 57, resets_at: "2026-03-25T18:00:00.000Z" },
        seven_day: { utilization: 12, resets_at: "2026-04-01T00:00:00.000Z" },
      },
      43,
      88,
    ],
    [
      "nested quota roots and extra alias fields",
      {
        quota: {
          fiveHour: { usedPercent: "35", resetAt: "2026-03-25T18:00:00.000Z" },
          sevenDay: { percent_used: 15, resetsAt: "2026-04-01T00:00:00.000Z" },
        },
      },
      65,
      85,
    ],
  ])("parses %s", (_label, data, fiveHourRemaining, sevenDayRemaining) => {
    expect(parseUsageResponse(data)).toEqual({
      success: true,
      five_hour: { percentRemaining: fiveHourRemaining, resetTimeIso: "2026-03-25T18:00:00.000Z" },
      seven_day: { percentRemaining: sevenDayRemaining, resetTimeIso: "2026-04-01T00:00:00.000Z" },
    });
  });

  it("drops invalid reset timestamps and only caps percent remaining above 100", () => {
    const result = parseUsageResponse({
      usage: {
        five_hour: { used_percentage: 120, resets_at: "\u001b[31mbad-reset" },
        seven_day: { used_percent: -10, reset_at: "not-a-date" },
      },
    });

    expect(result?.five_hour).toEqual({ percentRemaining: -20, resetTimeIso: undefined });
    expect(result?.seven_day).toEqual({ percentRemaining: 100, resetTimeIso: undefined });
  });

  it.each([
    ["null", null],
    ["a string", "bad-shape"],
    [
      "an invalid window",
      { rate_limits: { five_hour: { used_percentage: "nope" }, seven_day: { utilization: 12 } } },
    ],
    ["a missing window", { rateLimits: { fiveHour: { used_percentage: 30 } } }],
  ])("returns null for %s", (_label, data) => {
    expect(parseUsageResponse(data)).toBeNull();
    expect(parseOAuthUsageResponse(data)).toBeNull();
  });

  it.each([
    { utilization: 37.8, percentRemaining: 62 },
    { utilization: 0, percentRemaining: 100 },
    { utilization: 100, percentRemaining: 0 },
  ])(
    "parses enabled extra usage at $utilization% as remaining quota",
    ({ utilization, percentRemaining }) => {
      const result = parseOAuthUsageResponse({
        five_hour: { utilization: 57 },
        seven_day: { utilization: 12 },
        extra_usage: { is_enabled: true, utilization },
      });

      expect(result?.extra_usage).toEqual({ percentRemaining });
    },
  );

  it.each([
    { extra_usage: undefined },
    { extra_usage: { is_enabled: false, utilization: 37 } },
    { extra_usage: { is_enabled: true, utilization: "not-a-number" } },
    { extra_usage: { is_enabled: true, utilization: 101 } },
    { extra_usage: { is_enabled: true, utilization: -1 } },
    { extra_usage: { is_enabled: true, used_percentage: 37 } },
    { extra_usage: { is_enabled: true, usedPercent: 37 } },
    { extra_usage: { is_enabled: true, utilization: "37" } },
    { extraUsage: { is_enabled: true, utilization: 37 } },
  ])("ignores disabled, invalid or aliased extra usage %j", (extra) => {
    const result = parseOAuthUsageResponse({
      five_hour: { utilization: 57 },
      seven_day: { utilization: 12 },
      ...extra,
    });

    expect(result?.five_hour.percentRemaining).toBe(43);
    expect(result?.seven_day.percentRemaining).toBe(88);
    expect(result?.extra_usage).toBeUndefined();
  });

  it("parses the exact Fable weekly_scoped window from a sanitized response", () => {
    expect(parseUsageResponse(fableWeeklyUsage)).not.toHaveProperty("fable_weekly");
    expect(parseOAuthUsageResponse(fableWeeklyUsage)).toEqual({
      success: true,
      five_hour: { percentRemaining: 58, resetTimeIso: "2026-07-21T14:10:00.268Z" },
      seven_day: { percentRemaining: 72, resetTimeIso: "2026-07-27T07:00:00.268Z" },
      fable_weekly: { percentRemaining: 98, resetTimeIso: "2026-07-27T07:00:00.268Z" },
    });
  });

  it("keeps the existing windows when Fable scoped data is absent or malformed", () => {
    const withoutFable = parseOAuthUsageResponse({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 },
      limits: [
        { kind: "weekly_scoped", percent: 40, scope: { model: { display_name: "Opus" } } },
        {
          kind: "weekly_scoped",
          percent: 40,
          scope: { model: { display_name: "Claude Fable 5" } },
        },
        {
          kind: "weekly_scoped",
          percent: "not-a-number",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });

    expect(withoutFable).toEqual({
      success: true,
      five_hour: { percentRemaining: 80, resetTimeIso: undefined },
      seven_day: { percentRemaining: 70, resetTimeIso: undefined },
    });
  });

  it("accepts a zero-percent Fable window without a reset timestamp", () => {
    const result = parseOAuthUsageResponse({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 0,
          resets_at: null,
          scope: { model: { display_name: "Fable" } },
          is_active: false,
        },
      ],
    });

    expect(result?.fable_weekly).toEqual({ percentRemaining: 100, resetTimeIso: undefined });
  });
});

describe("buildClaudeCommandInvocation", () => {
  const windows = { platform: "win32" as const, comspec: "C:\\Windows\\System32\\cmd.exe" };

  it.each([
    [
      "wraps shim-based installs in cmd.exe",
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
      ["auth", "status", "--json"],
      {
        file: "C:\\Windows\\System32\\cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          '"C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd" "auth" "status" "--json"',
        ],
        display: "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd auth status --json",
      },
    ],
    [
      "keeps PATH-based commands behind cmd.exe",
      "claude.exe",
      ["--version"],
      {
        file: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", '"claude.exe" "--version"'],
        display: "claude.exe --version",
      },
    ],
    [
      "executes configured .exe paths directly",
      "C:/Users/alice/.local/bin/claude.exe",
      ["auth", "status", "--json"],
      {
        file: "C:/Users/alice/.local/bin/claude.exe",
        args: ["auth", "status", "--json"],
        display: "C:/Users/alice/.local/bin/claude.exe auth status --json",
      },
    ],
  ])("on Windows %s", (_label, binaryPath, args, expected) => {
    expect(buildClaudeCommandInvocation(binaryPath, args, windows)).toEqual(expected);
  });
});

describe("Claude CLI probe", () => {
  it("returns quota from Claude auth status JSON run from PATH, with no account identity", async () => {
    mockExecSequence([
      CLI_VERSION,
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 57, resets_at: "2026-03-25T18:00:00.000Z" },
            seven_day: { usedPercentage: 12, resetsAt: "2026-04-01T00:00:00.000Z" },
            extra_usage: { is_enabled: true, utilization: 37.8 },
          },
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("1.2.3");
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-auth-status-json");
    expect(diagnostics.binaryPath).toBe("claude (PATH)");
    expect(diagnostics.checkedCommands).toEqual(["claude --version", "claude auth status --json"]);
    expect(diagnostics.quota).toMatchObject({
      five_hour: { percentRemaining: 43 },
      seven_day: { percentRemaining: 88 },
    });
    expect(diagnostics.quota?.extra_usage).toBeUndefined();
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    // Claude CLI quota does not expose an account, so it must stay uncached.
    await expect(anthropicLoginsIdentity([])).resolves.toBeNull();
  });

  it("probes configured Windows Claude .exe paths without cmd wrapping", async () => {
    setProcessPlatform("win32");
    mockExecSequence([{ stdout: "2.1.123 (Claude Code)\n" }, cliQuotaStatus(10, 20)]);

    const diagnostics = await getAnthropicDiagnostics({
      binaryPath: " C:/Users/alice/.local/bin/claude.exe ",
    });

    expect(diagnostics.version).toBe("2.1.123");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.binaryPath).toBe("C:/Users/alice/.local/bin/claude.exe");
    expect(execFileMock.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["C:/Users/alice/.local/bin/claude.exe", ["--version"]],
      ["C:/Users/alice/.local/bin/claude.exe", ["auth", "status", "--json"]],
    ]);
  });

  it.each([
    ["a .cmd shim run through cmd.exe", "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd"],
    ["a .exe run directly", "C:/Users/alice/.local/bin/claude.exe"],
  ])("hides the console window of Windows Claude checks for %s", async (_label, binaryPath) => {
    setProcessPlatform("win32");
    mockExecSequence([{ stdout: "2.1.123 (Claude Code)\n" }, cliQuotaStatus(10, 20)]);

    await getAnthropicDiagnostics({ binaryPath });

    expect(execFileMock).toHaveBeenCalledTimes(2);
    for (const [, , options] of execFileMock.mock.calls) {
      expect(options).toMatchObject({ windowsHide: true });
    }
  });

  it("uses the first install folder that has claude when it is not on PATH", async () => {
    setProcessPlatform("linux");
    const [claudeLocal = "", localBin = ""] = CLAUDE_INSTALL_FOLDER_CANDIDATES;
    fsMocks.existsSync.mockImplementation(
      (path) => path === localBin || path === "/usr/local/bin/claude",
    );
    mockExecSequence([CLI_MISSING, { stdout: "2.1.0 (Claude Code)\n" }, cliQuotaStatus(10, 20)]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(fsMocks.existsSync.mock.calls.map(([path]) => path)).toEqual([claudeLocal, localBin]);
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("2.1.0");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.binaryPath).toBe(localBin);
    expect(diagnostics.checkedCommands).toEqual([
      "claude --version",
      buildClaudeCommandInvocation(localBin, ["--version"]).display,
      buildClaudeCommandInvocation(localBin, ["auth", "status", "--json"]).display,
    ]);
    expect(execFileMock.mock.calls[2]?.slice(0, 2)).toEqual([
      localBin,
      ["auth", "status", "--json"],
    ]);
  });

  it.each([
    [
      "the default claude on Linux, after checking the install folders",
      "linux",
      undefined,
      "claude --version",
      CLAUDE_INSTALL_FOLDER_CANDIDATES,
      `Claude CLI (\`claude\`) is not installed or not on PATH. Also checked: ${CLAUDE_INSTALL_FOLDER_CANDIDATES.join(", ")}.`,
    ],
    [
      "the default claude on Windows, without install folders",
      "win32",
      undefined,
      "claude --version",
      [],
      "Claude CLI (`claude`) is not installed or not on PATH.",
    ],
    [
      "a configured binary path, without install folders",
      "linux",
      " /Applications/Claude Code.app/Contents/MacOS/claude ",
      '"/Applications/Claude Code.app/Contents/MacOS/claude" --version',
      [],
      "Claude CLI (`/Applications/Claude Code.app/Contents/MacOS/claude`) is not installed or not on PATH.",
    ],
  ] as const)(
    "reports a missing Claude CLI for %s",
    async (_label, platform, binaryPath, checkedCommand, installFoldersChecked, message) => {
      setProcessPlatform(platform);
      mockExecSequence([CLI_MISSING]);

      const diagnostics = await getAnthropicDiagnostics({ binaryPath });

      expect(fsMocks.existsSync.mock.calls.map(([path]) => path)).toEqual(installFoldersChecked);
      expect(diagnostics).toEqual({
        installed: false,
        version: null,
        authStatus: "unknown",
        quotaSupported: false,
        quotaSource: "none",
        binaryPath: null,
        checkedCommands: [checkedCommand],
        message,
      });
      await expect(hasAnthropicCredentialsConfigured({ binaryPath })).resolves.toBe(false);
    },
  );

  it("reports unauthenticated Claude CLI status without reading OAuth credentials", async () => {
    mockExecSequence([
      CLI_VERSION,
      { code: 1, stderr: "Not logged in. Run `claude auth login` to continue." },
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("1.2.3");
    expect(diagnostics.authStatus).toBe("unauthenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("claude auth login");
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(false);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to plain auth status when --json is unsupported", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "Claude CLI version 1.2.3\n" },
      { code: 1, stderr: "unexpected argument '--json'" },
      { stdout: "Authenticated" },
    ]);
    readFileMock.mockRejectedValue(ENOENT_ERROR);

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.quotaSource).toBe("none");
    expect(diagnostics.checkedCommands).toEqual([
      "claude --version",
      "claude auth status --json",
      "claude auth status",
    ]);
    expect(diagnostics.message).toContain(NO_QUOTA_MESSAGE);
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
  });

  it.each([
    ["sanitizes unexpected output", { code: 1, stderr: "bad\u001b[31m-output" }, "bad-output"],
    [
      "reports a timeout",
      { code: "ETIMEDOUT", killed: true, errorMessage: "spawn claude ETIMEDOUT" },
      "Timed out while running Claude CLI auth status.",
    ],
  ])("%s from the auth status probe", async (_label, authStatusStep, expectedMessage) => {
    mockExecSequence([CLI_VERSION, authStatusStep]);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.message).toContain(expectedMessage);
    expect(diagnostics.message).not.toContain("\u001b");
  });

  it("caches fallback-backed diagnostics until the test helper clears the cache", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "token-1" } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "token-2" } }));
    fetchResponseMock
      .mockResolvedValueOnce(
        mockResponse(200, {
          usage: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse(200, {
          usage: { five_hour: { used_percentage: 30 }, seven_day: { used_percentage: 40 } },
        }),
      );

    const first = await getAnthropicDiagnostics();
    const second = await getAnthropicDiagnostics();
    expect(first.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quotaSource).toBe("claude-credentials-oauth-api");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearAnthropicDiagnosticsCacheForTests();

    const third = await getAnthropicDiagnostics();
    expect(third.quota?.five_hour.percentRemaining).toBe(70);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("OAuth credential sources", () => {
  it("falls back to Claude OAuth usage when local Claude auth omits quota windows", async () => {
    setUpCredentialsFileFallback(1);
    fetchResponseMock.mockResolvedValue(
      mockResponse(200, {
        ...fableWeeklyUsage,
        extra_usage: { is_enabled: true, utilization: 37.8 },
      }),
    );

    // Availability stays local-only: no credential read or usage request.
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.quota).toEqual({
      success: true,
      five_hour: { percentRemaining: 58, resetTimeIso: "2026-07-21T14:10:00.268Z" },
      seven_day: { percentRemaining: 72, resetTimeIso: "2026-07-27T07:00:00.268Z" },
      extra_usage: { percentRemaining: 62 },
      fable_weekly: { percentRemaining: 98, resetTimeIso: "2026-07-27T07:00:00.268Z" },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(ANTHROPIC_USAGE_URL);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("anthropic-beta")).toBe(
      "oauth-2025-04-20",
    );
    expect(bearerTokensSent()).toEqual(["Bearer oauth-access-token"]);
  });

  it("uses the macOS Keychain token when the Claude CLI gives no quota windows", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      CLI_VERSION,
      CLI_AUTHENTICATED,
      keychainToken("oauth-access-token-from-keychain"),
    ]);
    fetchResponseMock.mockResolvedValue(
      mockResponse(200, {
        oauth_usage: {
          fiveHour: { usedPercent: 25, resetAt: "2026-03-25T18:00:00.000Z" },
          sevenDay: { usedPercent: 40, resetAt: "2026-04-01T00:00:00.000Z" },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.oauthCredentialSource).toBe("claude-credentials");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(75);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(60);
    expect(bearerTokensSent()).toEqual(["Bearer oauth-access-token-from-keychain"]);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("falls back to the Claude credentials file when the macOS Keychain entry is unusable", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      CLI_VERSION,
      CLI_AUTHENTICATED,
      { stdout: JSON.stringify({ claudeAiOauth: {} }) },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token-from-file" } }),
    );
    fetchResponseMock.mockResolvedValue(
      mockResponse(200, {
        usage: { five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 10 } },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(95);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(90);
    expect(bearerTokensSent()).toEqual(["Bearer oauth-access-token-from-file"]);
  });

  it.each([
    ["fails", false],
    ["stalls past the deadline", true],
  ])("reports a rejected token whose error body %s", async (_label, stall) => {
    useFakeNow();
    setUpCredentialsFileFallback(1);
    fetchMock.mockImplementationOnce(unreadableResponse(401, { stall }));

    const pending = getAnthropicDiagnostics();
    await vi.advanceTimersByTimeAsync(5_000);
    const diagnostics = await pending;

    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.oauthCredentialSource).toBe("claude-credentials");
    expect(diagnostics.message).toContain("Anthropic API returned 401");
  });

  it.each([
    ["no credentials file on Linux", "linux", [], ENOENT_ERROR, [CREDENTIALS_FILE]],
    [
      "neither a Keychain entry nor a credentials file on macOS",
      "darwin",
      [{ code: 44, stderr: "The specified item could not be found in the keychain." }],
      ENOENT_ERROR,
      ["Claude Code-credentials", CREDENTIALS_FILE],
    ],
    [
      "a malformed access token",
      "linux",
      [],
      JSON.stringify({ claudeAiOauth: { accessToken: 123 } }),
      ["Claude OAuth access token missing"],
    ],
  ] as const)(
    "explains missing quota when Claude CLI is signed in but there is %s",
    async (_label, platform, keychainSteps, credentialsFile, expectedDetails) => {
      setProcessPlatform(platform);
      mockExecSequence([CLI_VERSION, CLI_AUTHENTICATED, ...keychainSteps]);
      if (credentialsFile instanceof Error) readFileMock.mockRejectedValue(credentialsFile);
      else readFileMock.mockResolvedValue(credentialsFile);

      const diagnostics = await getAnthropicDiagnostics();
      expect(diagnostics.installed).toBe(true);
      expect(diagnostics.authStatus).toBe("authenticated");
      expect(diagnostics.quotaSupported).toBe(false);
      expect(diagnostics.quotaSource).toBe("none");
      expect(diagnostics.message).toContain(NO_QUOTA_MESSAGE);
      for (const detail of expectedDetails) expect(diagnostics.message).toContain(detail);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("OAuth usage request", () => {
  it.each([
    ["invalid JSON", () => mockResponse(200, "{"), "Failed to parse Anthropic quota response"],
    [
      "an unexpected JSON shape",
      () => mockResponse(200, { ok: true }),
      "Unexpected Anthropic quota response shape",
    ],
  ])("returns no quota when the API returns %s", async (_label, response, expectedMessage) => {
    setUpCredentialsFileFallback(1);
    fetchResponseMock.mockResolvedValue(response());

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain(expectedMessage);
  });

  it("honors Retry-After delta-seconds, redacts the token and suppresses repeated requests", async () => {
    useFakeNow();
    setUpCredentialsFileFallback(3, "oauth-secret-token");
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(429, "rate limited oauth-\u001b[31msecret-token", "45"))
      .mockResolvedValueOnce(mockResponse(200, USAGE_10_20));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("Anthropic API error 429: rate limited [redacted]");
    expect(first.message).toContain(
      "Anthropic OAuth usage probe paused after HTTP 429; retry in 45s.",
    );
    expect(first.message).not.toContain("oauth-secret-token");
    expect(first.message).not.toContain("\u001b");

    await vi.advanceTimersByTimeAsync(5_001);
    const suppressed = await getAnthropicDiagnostics();
    expect(suppressed.message).toContain(
      "Anthropic OAuth usage probe paused after HTTP 429; retry in 40s.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(40_000);
    const retried = await getAnthropicDiagnostics();
    expect(retried.quotaSupported).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts an access token reconstructed while sanitizing a request error", async () => {
    setUpCredentialsFileFallback(1, "oauth-secret-token");
    fetchResponseMock.mockRejectedValue(
      new Error("request failed for oauth-\u001b[31msecret-token"),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.message).toContain("request failed for [redacted]");
    expect(diagnostics.message).not.toContain("oauth-secret-token");
    expect(diagnostics.message).not.toContain("\u001b");
  });

  it.each([
    ["a future HTTP date", "Fri, 10 Jul 2026 12:02:00 GMT", "120s"],
    ["missing", undefined, "30s"],
    ["invalid", "30junk", "30s"],
    ["negative", "-1", "30s"],
    ["zero", "0", "30s"],
    ["a past date", "Thu, 09 Jul 2026 12:00:00 GMT", "30s"],
    ["over fifteen minutes", "3600", "900s"],
  ])("pauses the probe for a %s Retry-After", async (_label, retryAfter, expectedRetry) => {
    useFakeNow();
    setUpCredentialsFileFallback(2);
    fetchResponseMock.mockResolvedValue(mockResponse(429, "rate limited", retryAfter));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain(`retry in ${expectedRetry}.`);

    await vi.advanceTimersByTimeAsync(5_001);
    await getAnthropicDiagnostics();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "cannot be read",
      false,
      undefined,
      0,
      "Anthropic API returned 429 Anthropic OAuth usage probe paused after HTTP 429; retry in 30s.",
      "retry in 25s.",
    ],
    [
      "stalls past the deadline",
      true,
      "45",
      5_000,
      "Anthropic API returned 429 Anthropic OAuth usage probe paused after HTTP 429; retry in 45s.",
      "retry in 40s.",
    ],
  ])(
    "establishes a cooldown when the 429 response body %s",
    async (_label, stall, retryAfter, stallMs, firstMessage, suppressedMessage) => {
      useFakeNow();
      setUpCredentialsFileFallback(2);
      fetchMock.mockImplementationOnce(unreadableResponse(429, { retryAfter, stall }));

      const pending = getAnthropicDiagnostics();
      await vi.advanceTimersByTimeAsync(stallMs);
      const first = await pending;
      expect(first.message).toContain(firstMessage);

      await vi.advanceTimersByTimeAsync(5_001);
      const suppressed = await getAnthropicDiagnostics();
      expect(suppressed.message).toContain(suppressedMessage);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("increases fallback backoff for consecutive 429 responses", async () => {
    useFakeNow();
    setUpCredentialsFileFallback(4);
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(429, "first"))
      .mockResolvedValueOnce(mockResponse(429, "second"))
      .mockResolvedValueOnce(mockResponse(200, USAGE_10_20));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("retry in 30s.");

    await vi.advanceTimersByTimeAsync(30_001);
    const second = await getAnthropicDiagnostics();
    expect(second.message).toContain("retry in 60s.");

    await vi.advanceTimersByTimeAsync(30_001);
    await getAnthropicDiagnostics();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await getAnthropicDiagnostics();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("resets the backoff sequence after a non-429 response", async () => {
    useFakeNow();
    setUpCredentialsFileFallback(4);
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(429, "first"))
      .mockResolvedValueOnce(mockResponse(500, "server\u001b[31m error"))
      .mockResolvedValueOnce(mockResponse(429, "second"))
      .mockResolvedValueOnce(mockResponse(500, "server error"));

    await getAnthropicDiagnostics();
    await vi.advanceTimersByTimeAsync(30_001);
    const serverError = await getAnthropicDiagnostics();
    expect(serverError.message).toContain("Anthropic API error 500: server error");
    expect(serverError.message).not.toContain("\u001b");
    await vi.advanceTimersByTimeAsync(5_001);
    const second429 = await getAnthropicDiagnostics();
    expect(second429.message).toContain("retry in 30s.");

    await vi.advanceTimersByTimeAsync(30_001);
    await getAnthropicDiagnostics();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("deduplicates concurrent OAuth usage requests for the same observed token", async () => {
    setUpCredentialsFileFallback(2);
    let resolveFetch!: (response: Response) => void;
    fetchResponseMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = getAnthropicDiagnostics({ binaryPath: "claude-a" });
    const second = getAnthropicDiagnostics({ binaryPath: "claude-b" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(mockResponse(200, USAGE_10_20));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.quotaSupported).toBe(true);
    expect(secondResult.quotaSupported).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not apply an old token cooldown to a newly observed token", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "old-token" } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "new-token" } }));
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(429, "rate limited", "900"))
      .mockResolvedValueOnce(mockResponse(200, USAGE_10_20));

    const first = await getAnthropicDiagnostics({ binaryPath: "claude-a" });
    expect(first.quotaSupported).toBe(false);
    const second = await getAnthropicDiagnostics({ binaryPath: "claude-b" });
    expect(second.quotaSupported).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("anthropic auth resolution", () => {
  /** One stored Claude login; `resolveError` when OpenCode could not return it. */
  const login = (value: Record<string, unknown>, resolveError?: string): CredentialRow => ({
    id: "claude",
    integrationId: "anthropic",
    label: "",
    active: true,
    value,
    ...(resolveError ? { resolveError } : {}),
  });

  it.each([
    [
      "resolves the OpenCode anthropic OAuth entry",
      login({ type: "oauth", access: "opencode-token", expires: 4_000 }),
      { state: "configured", accessToken: "opencode-token", expiresAt: 4_000 },
    ],
    [
      "resolves entries without an expiry",
      login({ type: "oauth", access: "opencode-token" }),
      { state: "configured", accessToken: "opencode-token" },
    ],
    [
      "ignores API key auth entries because the usage endpoint requires OAuth",
      login({ type: "api", access: "opencode-token" }),
      { state: "none" },
    ],
    ["ignores blank access tokens", login({ type: "oauth", access: "   " }), { state: "none" }],
    [
      "ignores a placeholder login that another plugin stores instead of a token",
      login({
        type: "oauth",
        access: "common-auth-placeholder.anthropic",
        refresh: "common-auth-placeholder.anthropic",
        expires: 4_000,
        commonAuthPlaceholder: true,
        metadata: { commonAuthPlaceholder: true },
      }),
      { state: "none" },
    ],
    [
      "reports expired entries as expired instead of configured",
      login({ type: "oauth", access: "opencode-token", expires: 1_000 }),
      { state: "expired", expiresAt: 1_000 },
    ],
    [
      "reports a login OpenCode could not return as failed",
      login({ type: "oauth" }, "refresh_failed: HTTP 500"),
      { state: "failed", error: "refresh_failed: HTTP 500" },
    ],
  ])("%s", (_label, row, expected) => {
    expect(resolveAnthropicOAuth(row, { nowMs: 2_000 })).toStrictEqual(expected);
  });
});

describe("readAnthropicLogins", () => {
  it("keeps an expired login, so it shows as its own error", async () => {
    mockOpenCodeLogin("old-token", Date.now() - 1);

    await expect(readAnthropicLogins()).resolves.toMatchObject([
      { row: { id: "login-1" }, auth: { state: "expired" } },
    ]);
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    await expect(anthropicLoginsIdentity(await readAnthropicLogins())).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("skips a placeholder login, so its fake token is never sent to Anthropic", async () => {
    world.storeLogins([
      {
        id: "login-1",
        integrationId: "anthropic",
        active: 1,
        updated: 1,
        value: {
          type: "oauth",
          access: "common-auth-placeholder.anthropic",
          refresh: "common-auth-placeholder.anthropic",
          expires: Date.now() + 60_000,
          metadata: { commonAuthPlaceholder: true },
        },
      },
    ]);

    await expect(readAnthropicLogins()).resolves.toStrictEqual([]);
  });
});

describe("anthropicLoginsIdentity", () => {
  async function identity() {
    return anthropicLoginsIdentity(await readAnthropicLogins());
  }

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "derives identity from the OpenCode logins, without asking the Claude CLI",
    async () => {
      mockOpenCodeLogin("opencode-access-secret");
      const first = await identity();
      mockOpenCodeLogin("another-access-secret");
      const second = await identity();

      expect(first).not.toBeNull();
      expect(second).not.toEqual(first);
      expect(JSON.stringify([first, second])).not.toMatch(/access-secret/u);
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it("counts an OpenCode login it could not read as present but derives no identity from it", async () => {
    mockExecSequence([CLI_MISSING]);
    const integration = createFakeIntegration([
      {
        integrationId: "anthropic",
        id: "login-1",
        label: "default",
        registered: true,
        method: "oauth",
        value: { type: "oauth", access: "old" },
        resolveError: "HTTP 500",
      },
    ]);
    const unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));

    try {
      await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
      await expect(identity()).resolves.toBeNull();
    } finally {
      unbind();
    }
  });

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "derives identity from Claude's credentials without OpenCode logins",
    async () => {
      setUpCredentialsFileFallback(1, "claude-access-secret");

      const resolved = await identity();

      expect(resolved).not.toBeNull();
      expect(JSON.stringify(resolved)).not.toContain("claude-access-secret");
    },
  );
});

describe("Anthropic runtime credentials", () => {
  function context(
    config: Record<string, unknown> = {},
    providerIds = ["anthropic", "claude-code"],
  ) {
    return createProviderAvailabilityContext({ providerIds, configOverrides: config });
  }

  async function identity(ctx: ReturnType<typeof context>) {
    const policy = anthropicProvider.cachePolicy;
    if (policy.kind !== "resolved-auth") throw new Error("Expected Anthropic auth cache policy");
    return policy.resolveIdentity(ctx, {});
  }

  function store() {
    const loaded = {
      path: "settings.jsonc",
      exists: true,
      settings: defaultSettings(),
      issues: [],
      fromFile: [],
      notRead: [],
    };
    const host = {
      client: context().client,
      workspaceRoot: world.root,
      locationDirectory: world.root,
      settings: () => loaded,
      providers: () => [anthropicProvider],
    };
    return createQuotaStore({ source: (model) => loadProviderSource(host, model), file: null });
  }

  it("uses account B for claude-code and a different cache key from stored account A", async () => {
    mockOpenCodeLogin("account-a");
    setUpCredentialsFileFallback(1, "account-b");
    fetchResponseMock.mockResolvedValue(mockResponse(200, USAGE_10_20));
    const anthropicIdentity = await identity(context({ currentProviderID: "anthropic" }));
    const claudeCodeIdentity = await identity(context({ currentProviderID: "claude-code" }));
    expect(anthropicIdentity).not.toBeNull();
    expect(claudeCodeIdentity).not.toBeNull();
    expect(claudeCodeIdentity).not.toEqual(anthropicIdentity);
    expect(JSON.stringify([anthropicIdentity, claudeCodeIdentity])).not.toMatch(/account-[ab]/u);

    const quota = store();
    const anthropic = { id: "claude-sonnet-4-6", providerID: "anthropic" };
    const claudeCode = { id: "claude-sonnet-4-6", providerID: "claude-code" };
    try {
      const first = await quota.refresh({ reason: "poll", model: anthropic });
      expect(first.providers[0]?.rows.map((row) => row.percentRemaining)).toEqual([90, 80]);

      const beforeFetch = await quota.snapshot({ model: claudeCode, refresh: false });
      expect(beforeFetch.providers[0]?.rows).toEqual([]);
      fetchResponseMock.mockResolvedValue(
        mockResponse(200, { five_hour: { utilization: 60 }, seven_day: { utilization: 70 } }),
      );
      const second = await quota.refresh({ reason: "poll", model: claudeCode });
      expect(second.providers[0]?.rows.map((row) => row.percentRemaining)).toEqual([40, 30]);
      expect(bearerTokensSent()).toEqual(["Bearer account-a", "Bearer account-b"]);

      const back = await quota.snapshot({ model: anthropic, refresh: false });
      expect(back.providers[0]?.rows.map((row) => row.percentRemaining)).toEqual([90, 80]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await quota.dispose();
    }
  });

  it("shows Claude Code rows with an expired stored Anthropic login", async () => {
    mockOpenCodeLogin("expired-account-a", Date.now() - 1);
    setUpCredentialsFileFallback(1, "account-b");
    fetchResponseMock.mockResolvedValue(mockResponse(200, USAGE_10_20));
    const quota = store();
    try {
      const snapshot = await quota.refresh({
        reason: "poll",
        model: { id: "claude-sonnet-4-6", providerID: "claude-code" },
      });
      expect(snapshot.providers[0]?.rows.map((row) => row.percentRemaining)).toEqual([90, 80]);
      expect(snapshot.providers[0]?.error).toBeUndefined();
      expect(bearerTokensSent()).toEqual(["Bearer account-b"]);
    } finally {
      await quota.dispose();
    }
  });

  it("separates an expired Anthropic result from Claude CLI quota without an account identity", async () => {
    mockOpenCodeLogin("expired-account-a", Date.now() - 1);
    mockExecSequence([CLI_VERSION, cliQuotaStatus(60, 70)]);
    const quota = store();
    try {
      const first = await quota.refresh({ reason: "poll", model: { providerID: "anthropic" } });
      expect(first.providers[0]?.rows).toEqual([]);
      expect(first.providers[0]?.error?.code).toBe("login_expired");

      const second = await quota.refresh({ reason: "poll", model: { providerID: "claude-code" } });
      expect(second.providers[0]?.rows.map((row) => row.percentRemaining)).toEqual([40, 30]);
      expect(second.providers[0]?.error).toBeUndefined();

      const back = await quota.snapshot({ model: { providerID: "anthropic" }, refresh: false });
      expect(back.providers[0]?.rows).toEqual([]);
      expect(back.providers[0]?.error?.code).toBe("login_expired");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await quota.dispose();
    }
  });

  it.each([undefined, "", "   "])(
    "keeps the Anthropic fallback for a placeholder or tombstone with access=%j",
    async (access) => {
      mockOpenCodeLogin(access, 0);
      setUpCredentialsFileFallback(1, "account-b");
      fetchResponseMock.mockResolvedValue(mockResponse(200, USAGE_10_20));
      const ctx = context({ currentProviderID: "anthropic" });

      await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
      const result = await anthropicProvider.fetch(ctx);
      expect(result.accounts[0]?.rows.map((row) => row.percentRemaining)).toEqual([90, 80]);
      expect(bearerTokensSent()).toEqual(["Bearer account-b"]);
    },
  );

  it.each([
    { currentProviderID: "claude-code" },
    { currentModel: "CLAUDE-CODE/claude-sonnet-4-6" },
    {},
  ])("uses Claude credentials for the claude-code runtime with %j", async (config) => {
    mockOpenCodeLogin("account-a");
    setUpCredentialsFileFallback(1, "account-b");
    fetchResponseMock.mockResolvedValue(mockResponse(200, USAGE_10_20));
    const ctx = context(config, ["claude-code"]);

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    const result = await anthropicProvider.fetch(ctx);
    expect(result.accounts[0]?.rows.map((row) => row.percentRemaining)).toEqual([90, 80]);
    expect(bearerTokensSent()).toEqual(["Bearer account-b"]);
    expect(await identity(ctx)).toBe(await anthropicLoginsIdentity([]));
  });

  it.each([
    { currentProviderID: "anthropic" },
    { currentProviderID: "anthropic", currentModel: "claude-code/claude-sonnet-4-6" },
    { currentModel: "ANTHROPIC/claude-sonnet-4-6" },
    {},
  ])("keeps stored Anthropic credentials first with %j", async (config) => {
    mockOpenCodeLogin("account-a");
    fetchResponseMock.mockResolvedValue(mockResponse(200, USAGE_10_20));
    const ctx = context(config);

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    const result = await anthropicProvider.fetch(ctx);
    expect(result.accounts[0]?.rows.map((row) => row.percentRemaining)).toEqual([90, 80]);
    expect(bearerTokensSent()).toEqual(["Bearer account-a"]);
    expect(await identity(ctx)).toBe(await anthropicLoginsIdentity(await readAnthropicLogins()));
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("keeps an expired Anthropic login as an error instead of using Claude Code", async () => {
    mockOpenCodeLogin("expired-account-a", Date.now() - 1);
    const ctx = context({ currentProviderID: "anthropic" });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    const result = await anthropicProvider.fetch(ctx);
    expect(result.accounts[0]?.rows).toEqual([]);
    expect(result.accounts[0]?.errors[0]?.message).toContain("sign-in expired");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not count a stored Anthropic login when Claude Code is signed out", async () => {
    mockOpenCodeLogin("account-a");
    mockExecSequence([CLI_VERSION, { stdout: JSON.stringify({ authenticated: false }) }]);
    const ctx = context({ currentProviderID: "claude-code" });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
    await expect(identity(ctx)).resolves.toBeNull();
    await expect(anthropicProvider.fetch(ctx)).resolves.toMatchObject({
      attempted: false,
      accounts: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
