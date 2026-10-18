import { afterEach, describe, expect, it, vi } from "vitest";

import { execFile } from "child_process";
import { readFile } from "fs/promises";

import { fetchWithTimeout } from "../src/lib/http.js";
import {
  buildClaudeCommandInvocation,
  clearAnthropicDiagnosticsCacheForTests,
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  parseUsageResponse,
  queryAnthropicQuota,
} from "../src/lib/anthropic.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: vi.fn(),
}));

type ExecSequenceStep = {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  errorMessage?: string;
  killed?: boolean;
};

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const execFileMock = vi.mocked(execFile);
const readFileMock = vi.mocked(readFile);
const fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);
const originalProcessPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function mockExecSequence(steps: ExecSequenceStep[], repeats = 1): void {
  steps = Array.from({ length: repeats }, () => steps).flat();
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

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function mockInvalidJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockRejectedValue(new Error("invalid json")),
    text: vi.fn().mockResolvedValue("{"),
  } as unknown as Response;
}

afterEach(() => {
  execFileMock.mockReset();
  readFileMock.mockReset();
  fetchWithTimeoutMock.mockReset();
  clearAnthropicDiagnosticsCacheForTests();
  if (originalProcessPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalProcessPlatformDescriptor);
  }
});

describe("parseUsageResponse", () => {
  it("parses the current five_hour / seven_day response shape", () => {
    const result = parseUsageResponse({
      five_hour: { utilization: 57, resets_at: "2026-03-25T18:00:00.000Z" },
      seven_day: { utilization: 12, resets_at: "2026-04-01T00:00:00.000Z" },
    });

    expect(result).not.toBeNull();
    expect(result?.five_hour.percentRemaining).toBe(43);
    expect(result?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(result?.seven_day.percentRemaining).toBe(88);
    expect(result?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("parses nested quota roots and extra alias fields", () => {
    const result = parseUsageResponse({
      quota: {
        fiveHour: { usedPercent: "35", resetAt: "2026-03-25T18:00:00.000Z" },
        sevenDay: { percent_used: 15, resetsAt: "2026-04-01T00:00:00.000Z" },
      },
    });

    expect(result?.five_hour.percentRemaining).toBe(65);
    expect(result?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(result?.seven_day.percentRemaining).toBe(85);
    expect(result?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("drops invalid reset timestamps and only caps percent remaining above 100", () => {
    const result = parseUsageResponse({
      usage: {
        five_hour: { used_percentage: 120, resets_at: "\u001b[31mbad-reset" },
        seven_day: { used_percent: -10, reset_at: "not-a-date" },
      },
    });

    expect(result?.five_hour.percentRemaining).toBe(-20);
    expect(result?.five_hour.resetTimeIso).toBeUndefined();
    expect(result?.seven_day.percentRemaining).toBe(100);
    expect(result?.seven_day.resetTimeIso).toBeUndefined();
  });

  it("returns null when required quota windows are missing or invalid", () => {
    expect(parseUsageResponse(null)).toBeNull();
    expect(parseUsageResponse("bad-shape")).toBeNull();
    expect(
      parseUsageResponse({
        rate_limits: {
          five_hour: { used_percentage: "nope" },
          seven_day: { utilization: 12 },
        },
      }),
    ).toBeNull();
    expect(
      parseUsageResponse({
        rateLimits: {
          fiveHour: { used_percentage: 30 },
        },
      }),
    ).toBeNull();
  });
});

describe("Claude CLI diagnostics", () => {
  it("builds a Windows-safe Claude CLI invocation for shim-based installs", () => {
    const invocation = buildClaudeCommandInvocation(
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
      ["auth", "status", "--json"],
      { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" },
    );

    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '"C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd" "auth" "status" "--json"',
      ],
      display: "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd auth status --json",
    });
  });

  it("keeps Windows PATH-based Claude commands behind cmd.exe", () => {
    const invocation = buildClaudeCommandInvocation("claude.exe", ["--version"], {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"claude.exe" "--version"'],
      display: "claude.exe --version",
    });
  });

  it("executes configured Windows Claude .exe paths directly", () => {
    const invocation = buildClaudeCommandInvocation(
      "C:/Users/alice/.local/bin/claude.exe",
      ["auth", "status", "--json"],
      { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" },
    );

    expect(invocation).toEqual({
      file: "C:/Users/alice/.local/bin/claude.exe",
      args: ["auth", "status", "--json"],
      display: "C:/Users/alice/.local/bin/claude.exe auth status --json",
    });
  });

  it("probes configured Windows Claude .exe paths without cmd wrapping", async () => {
    setProcessPlatform("win32");
    mockExecSequence([
      { stdout: "2.1.123 (Claude Code)\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics({
      binaryPath: " C:/Users/alice/.local/bin/claude.exe ",
    });

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("2.1.123");
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.checkedCommands).toEqual([
      "C:/Users/alice/.local/bin/claude.exe --version",
      "C:/Users/alice/.local/bin/claude.exe auth status --json",
    ]);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "C:/Users/alice/.local/bin/claude.exe",
      ["--version"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "C:/Users/alice/.local/bin/claude.exe",
      ["auth", "status", "--json"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("reports missing Claude CLI as unavailable without quota data", async () => {
    mockExecSequence(
      [
        {
          code: "ENOENT",
          errorMessage: "spawn claude ENOENT",
        },
      ],
      3,
    );

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics).toEqual({
      installed: false,
      version: null,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: ["claude --version"],
      message: "Claude CLI (`claude`) is not installed or not on PATH.",
    });
    // Not installed at all: isAvailable() gates on this and hides the
    // provider entirely, so no error needs to reach the UI here.
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(false);
    await expect(queryAnthropicQuota()).resolves.toEqual({
      success: false,
      error: "Claude CLI (`claude`) is not installed or not on PATH.",
    });
  });

  it("uses a configured Claude binary path for probe commands", async () => {
    mockExecSequence([
      {
        code: "ENOENT",
        errorMessage: "spawn /Applications/Claude Code.app/Contents/MacOS/claude ENOENT",
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics({
      binaryPath: " /Applications/Claude Code.app/Contents/MacOS/claude ",
    });

    expect(diagnostics.checkedCommands).toEqual([
      '"/Applications/Claude Code.app/Contents/MacOS/claude" --version',
    ]);
    expect(diagnostics.message).toContain("/Applications/Claude Code.app/Contents/MacOS/claude");
  });

  it("reports unauthenticated Claude CLI status", async () => {
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          code: 1,
          stderr: "Not logged in. Run `claude auth login` to continue.",
        },
      ],
      3,
    );

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("1.2.3");
    expect(diagnostics.authStatus).toBe("unauthenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("claude auth login");
    // Installed but session expired: stays "available" so the UI surfaces an
    // actionable re-auth error instead of the provider silently vanishing.
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    await expect(queryAnthropicQuota()).resolves.toEqual({
      success: false,
      error: expect.stringContaining("claude auth login"),
    });
  });

  it("returns quota data when Claude auth status JSON includes quota windows", async () => {
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            authenticated: true,
            quota: {
              five_hour: {
                used_percentage: 57,
                resets_at: "2026-03-25T18:00:00.000Z",
              },
              seven_day: {
                usedPercentage: 12,
                resetsAt: "2026-04-01T00:00:00.000Z",
              },
            },
          }),
        },
      ],
      3,
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-auth-status-json");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(43);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(88);

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(true);
    if (quota?.success) {
      expect(quota.five_hour.percentRemaining).toBe(43);
      expect(quota.seven_day.percentRemaining).toBe(88);
    }
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
  });

  it("keeps Anthropic availability local-only when only the OAuth fallback can provide quota", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);

    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("falls back to Claude OAuth usage when local Claude auth omits quota windows", async () => {
    setProcessPlatform("linux");
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            authenticated: true,
          }),
        },
      ],
      3,
    );
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue(
      mockJsonResponse({
        oauth_usage: {
          fiveHour: {
            usedPercent: 35,
            resetAt: "2026-03-25T18:00:00.000Z",
          },
          sevenDay: {
            percent_used: 15,
            resetsAt: "2026-04-01T00:00:00.000Z",
          },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(65);
    expect(diagnostics.quota?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(85);
    expect(diagnostics.quota?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      ANTHROPIC_USAGE_URL,
      {
        headers: {
          Authorization: "Bearer oauth-access-token",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      undefined,
    );

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(true);
    if (quota?.success) {
      expect(quota.five_hour.percentRemaining).toBe(65);
      expect(quota.seven_day.percentRemaining).toBe(85);
    }

    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to macOS Keychain Claude OAuth credentials when local Claude auth omits quota windows", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
      {
        stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: "oauth-access-token-from-keychain",
          },
        }),
      },
    ]);
    fetchWithTimeoutMock.mockResolvedValue(
      mockJsonResponse({
        oauth_usage: {
          fiveHour: {
            usedPercent: 25,
            resetAt: "2026-03-25T18:00:00.000Z",
          },
          sevenDay: {
            usedPercent: 40,
            resetAt: "2026-04-01T00:00:00.000Z",
          },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(75);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(60);
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      "security",
      [
        "find-generic-password",
        "-a",
        expect.any(String),
        "-w",
        "-s",
        "Claude Code-credentials",
      ],
      expect.any(Object),
      expect.any(Function),
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      ANTHROPIC_USAGE_URL,
      {
        headers: {
          Authorization: "Bearer oauth-access-token-from-keychain",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      undefined,
    );
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to the Claude credentials file when the macOS Keychain entry is unusable", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
      {
        stdout: JSON.stringify({
          claudeAiOauth: {},
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token-from-file",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue(
      mockJsonResponse({
        usage: {
          five_hour: { used_percentage: 5 },
          seven_day: { used_percentage: 10 },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(95);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(90);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      ANTHROPIC_USAGE_URL,
      {
        headers: {
          Authorization: "Bearer oauth-access-token-from-file",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      undefined,
    );
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("returns no quota when the Claude OAuth fallback credentials are unavailable", async () => {
    setProcessPlatform("linux");
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            authenticated: true,
          }),
        },
      ],
      3,
    );
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.quotaSource).toBe("none");
    expect(diagnostics.message).toContain(
      "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.",
    );
    expect(diagnostics.message).toContain(".claude/.credentials.json");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain(
        "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.",
      );
      expect(quota.error).toContain(".claude/.credentials.json");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it("includes the macOS Keychain source when Claude OAuth fallback credentials are unavailable on macOS", async () => {
    setProcessPlatform("darwin");
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            authenticated: true,
          }),
        },
        {
          code: 44,
          stderr: "The specified item could not be found in the keychain.",
        },
      ],
      3,
    );
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Claude Code-credentials");
    expect(diagnostics.message).toContain(".claude/.credentials.json");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Claude Code-credentials");
      expect(quota.error).toContain(".claude/.credentials.json");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenCalledTimes(6);
  });

  it("returns no quota when the Claude OAuth fallback access token is malformed", async () => {
    setProcessPlatform("linux");
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            authenticated: true,
          }),
        },
      ],
      3,
    );
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 123,
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Claude OAuth access token missing");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Claude OAuth access token missing");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("returns no quota when the Claude OAuth fallback API returns a non-2xx response", async () => {
    setProcessPlatform("linux");
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            authenticated: true,
          }),
        },
      ],
      3,
    );
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn(),
      text: vi.fn().mockResolvedValue("rate\u001b[31m limited"),
    } as unknown as Response);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Anthropic API error 429: rate limited");
    expect(diagnostics.message).not.toContain("\u001b");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Anthropic OAuth usage probe paused after HTTP 429");
      expect(quota.error).not.toContain("\u001b");
    }
  });

  it("returns no quota when the Claude OAuth fallback API returns invalid JSON", async () => {
    setProcessPlatform("linux");
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            authenticated: true,
          }),
        },
      ],
      3,
    );
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue(mockInvalidJsonResponse());

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Failed to parse Anthropic quota response");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Failed to parse Anthropic quota response");
    }
  });

  it("returns no quota when the Claude OAuth fallback API returns an unexpected JSON shape", async () => {
    setProcessPlatform("linux");
    mockExecSequence(
      [
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            authenticated: true,
          }),
        },
      ],
      3,
    );
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue(mockJsonResponse({ ok: true }));

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Unexpected Anthropic quota response shape");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Unexpected Anthropic quota response shape");
    }
  });

  it("falls back to plain auth status when --json is unsupported", async () => {
    setProcessPlatform("linux");
    mockExecSequence(
      [
        { stdout: "Claude CLI version 1.2.3\n" },
        {
          code: 1,
          stderr: "unexpected argument '--json'",
        },
        {
          stdout: "Authenticated",
        },
      ],
      3,
    );
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

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
    expect(diagnostics.message).toContain(
      "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.",
    );
    expect(diagnostics.message).toContain(".claude/.credentials.json");
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain(
        "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.",
      );
      expect(quota.error).toContain(".claude/.credentials.json");
    }
  });

  it("sanitizes unexpected auth probe output", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        code: 1,
        stderr: "bad\u001b[31m-output",
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.message).toContain("bad-output");
    expect(diagnostics.message).not.toContain("\u001b");
  });

  it("re-probes local quota without reusing another CLI account within the old TTL", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 30 },
            seven_day: { used_percentage: 40 },
          },
        }),
      },
    ]);

    const first = await getAnthropicDiagnostics();
    const second = await getAnthropicDiagnostics();
    expect(first.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quota?.five_hour.percentRemaining).toBe(70);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("bypassCache re-probes immediately instead of waiting out the cache or an app relaunch", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { code: 1, stderr: "Not logged in. Run `claude auth login` to continue." },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 30 },
            seven_day: { used_percentage: 40 },
          },
        }),
      },
    ]);

    const beforeLogin = await getAnthropicDiagnostics();
    expect(beforeLogin.authStatus).toBe("unauthenticated");

    // An explicit refresh after login must observe the new authenticated state.
    const afterLoginBypassed = await getAnthropicDiagnostics({ bypassCache: true });
    expect(afterLoginBypassed.authStatus).toBe("authenticated");
    expect(afterLoginBypassed.quota?.five_hour.percentRemaining).toBe(70);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("hasAnthropicCredentialsConfigured and queryAnthropicQuota forward bypassCache", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { code: 1, stderr: "Not logged in. Run `claude auth login` to continue." },
      { stdout: "claude 1.2.3\n" },
      { code: 1, stderr: "Not logged in. Run `claude auth login` to continue." },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 15 },
            seven_day: { used_percentage: 25 },
          },
        }),
      },
    ]);

    await hasAnthropicCredentialsConfigured();
    const quotaBefore = await queryAnthropicQuota();
    expect(quotaBefore).toEqual({
      success: false,
      error: expect.stringContaining("claude auth login"),
    });

    const quotaAfter = await queryAnthropicQuota({ bypassCache: true });
    expect(quotaAfter).toMatchObject({
      success: true,
      five_hour: { percentRemaining: 85 },
    });
  });

  it("re-reads fallback credentials and quota after an OAuth account switch", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);
    readFileMock
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-access-token-1" },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-access-token-2" },
        }),
      );
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        mockJsonResponse({
          usage: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          usage: {
            five_hour: { used_percentage: 30 },
            seven_day: { used_percentage: 40 },
          },
        }),
      );

    const first = await getAnthropicDiagnostics();
    const second = await getAnthropicDiagnostics();
    expect(first.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quota?.five_hour.percentRemaining).toBe(70);
    expect(first.quotaSource).toBe("claude-credentials-oauth-api");
    expect(second.quotaSource).toBe("claude-credentials-oauth-api");
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);

    expect(fetchWithTimeoutMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer oauth-access-token-1",
    );
    expect(fetchWithTimeoutMock.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer oauth-access-token-2",
    );
  });

  it("returns a sanitized error result when the CLI probe throws unexpectedly", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error("probe \u001b[31mboom");
    });

    const result = await queryAnthropicQuota();
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      expect(result.error).toContain("Claude CLI probe failed");
      expect(result.error).toContain("probe boom");
      expect(result.error).not.toContain("\u001b");
    }
  });
});

describe("Anthropic OAuth rate-limit recovery", () => {
  const startMs = Date.parse("2026-10-08T10:00:00Z");
  const usage = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } };

  function prepareOAuth(token = "account-a-token"): void {
    setProcessPlatform("linux");
    vi.useFakeTimers();
    vi.setSystemTime(startMs);
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      callback(null, args?.includes("--version") ? "claude 1.2.3" : '{"authenticated":true}', "");
      return {} as never;
    });
    readFileMock.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  }

  function rateLimited(retryAfter?: string, body = "rate limited"): Response {
    return new Response(body, {
      status: 429,
      headers: retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
    });
  }

  it.each([
    [undefined, 30_000],
    ["90", 90_000],
    ["Thu, 08 Oct 2026 10:02:00 GMT", 120_000],
    ["invalid", 30_000],
    ["0", 30_000],
    ["-5", 30_000],
    ["Thu, 08 Oct 2026 09:00:00 GMT", 30_000],
    ["999999", 900_000],
  ])("honors bounded Retry-After %s even on forced refresh", async (header, delayMs) => {
    prepareOAuth();
    fetchWithTimeoutMock
      .mockResolvedValueOnce(rateLimited(header))
      .mockResolvedValueOnce(mockJsonResponse(usage));
    expect(await queryAnthropicQuota()).toMatchObject({ success: false });
    vi.setSystemTime(startMs + delayMs - 1);
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({
      success: false,
      error: expect.stringContaining("retry in 1s"),
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(startMs + delayMs);
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({ success: true });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("backs off repeated 429s and resets after a successful request", async () => {
    prepareOAuth();
    fetchWithTimeoutMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(mockJsonResponse(usage))
      .mockResolvedValueOnce(rateLimited());
    await queryAnthropicQuota();
    vi.setSystemTime(startMs + 30_000);
    expect(await queryAnthropicQuota()).toMatchObject({
      error: expect.stringContaining("retry in 60s"),
    });
    vi.setSystemTime(startMs + 89_999);
    await queryAnthropicQuota({ bypassCache: true });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(startMs + 90_000);
    expect(await queryAnthropicQuota()).toMatchObject({ success: true });
    expect(await queryAnthropicQuota()).toMatchObject({
      error: expect.stringContaining("retry in 30s"),
    });
  });

  it("keeps account A's cooldown across an A/B/A switch without blocking B", async () => {
    prepareOAuth();
    fetchWithTimeoutMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(mockJsonResponse(usage));
    await queryAnthropicQuota();
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "account-b-token" } }),
    );
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({ success: true });
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "account-a-token" } }),
    );
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({
      success: false,
      error: expect.stringContaining("HTTP 429"),
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent OAuth probes including forced refreshes", async () => {
    prepareOAuth();
    let resolveRequest!: (response: Response) => void;
    fetchWithTimeoutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const first = queryAnthropicQuota();
    const second = queryAnthropicQuota({ bypassCache: true });
    await vi.waitFor(() => expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1));
    resolveRequest(rateLimited());
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ success: false }),
      expect.objectContaining({ success: false }),
    ]);
    await queryAnthropicQuota({ bypassCache: true });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache 401 errors or prevent re-authentication and refresh", async () => {
    prepareOAuth();
    fetchWithTimeoutMock
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(mockJsonResponse(usage));
    expect(await queryAnthropicQuota()).toMatchObject({
      success: false,
      error: expect.stringContaining("401"),
    });
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({ success: true });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it.each([429, 401, "network"])("redacts credentials from %s diagnostics", async (failure) => {
    prepareOAuth();
    if (failure === "network") {
      fetchWithTimeoutMock.mockRejectedValue(new Error("request failed: account-a-token"));
    } else {
      fetchWithTimeoutMock.mockResolvedValue(
        new Response("Bearer account-a-token", { status: failure }),
      );
    }
    const result = await queryAnthropicQuota();
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).not.toContain("account-a-token");
    expect(JSON.stringify(result)).toContain("[redacted]");
  });

  it("caps repeated 429 backoff at fifteen minutes", async () => {
    prepareOAuth();
    fetchWithTimeoutMock.mockImplementation(async () => rateLimited());
    let nowMs = startMs;
    for (const seconds of [30, 60, 120, 240, 480, 900, 900]) {
      expect(await queryAnthropicQuota()).toMatchObject({
        error: expect.stringContaining(`retry in ${seconds}s`),
      });
      nowMs += seconds * 1_000;
      vi.setSystemTime(nowMs);
    }
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(7);
  });

  it("retains cooldown when the 429 response body cannot be read", async () => {
    prepareOAuth();
    fetchWithTimeoutMock.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "60" }),
      text: vi.fn().mockRejectedValue(new Error("body timeout")),
    } as unknown as Response);
    await queryAnthropicQuota();
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({
      error: expect.stringContaining("retry in 60s"),
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("does not share pending OAuth responses across accounts", async () => {
    prepareOAuth();
    let resolveA!: (response: Response) => void;
    fetchWithTimeoutMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          five_hour: { utilization: 70 },
          seven_day: { utilization: 80 },
        }),
      );
    const pendingA = queryAnthropicQuota();
    await vi.waitFor(() => expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "account-b-token" } }),
    );
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({
      success: true,
      five_hour: { percentRemaining: 30 },
    });
    resolveA(rateLimited());
    expect(await pendingA).toMatchObject({ success: false });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("allows fresh CLI quota during an OAuth cooldown", async () => {
    prepareOAuth();
    fetchWithTimeoutMock.mockResolvedValue(rateLimited());
    await queryAnthropicQuota();
    mockExecSequence([
      { stdout: "claude 1.2.3" },
      { stdout: JSON.stringify({ authenticated: true, quota: usage }) },
    ]);
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({ success: true });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("releases pending request state after a network failure", async () => {
    prepareOAuth();
    fetchWithTimeoutMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(mockJsonResponse(usage));
    expect(await queryAnthropicQuota()).toMatchObject({ success: false });
    expect(await queryAnthropicQuota({ bypassCache: true })).toMatchObject({ success: true });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });
});
