import { execFile } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBlCommandInvocation,
  clearAlibabaCliCacheForTests,
  parseBlTokenPlanUsageJson,
  probeAlibabaCliUsage,
} from "../src/lib/alibaba-cli.js";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

// Synthetic fixtures matching bailian-cli 1.22.0; not captured account data.
const usage = {
  per5HourPercentage: 0,
  per1WeekPercentage: 1,
  per1WeekResetTime: 1_800_000_000_000,
};
const secret = "SENTINEL_CONSOLE_CREDENTIAL";
function reply(stdout: string, code?: number | string, stderr = secret) {
  vi.mocked(execFile).mockImplementationOnce(((
    _file: unknown,
    _args: unknown,
    _options: unknown,
    callback: any,
  ) => {
    callback(
      code === undefined ? null : Object.assign(new Error(secret), { code }),
      stdout,
      stderr,
    );
  }) as any);
}

beforeEach(() => {
  vi.resetAllMocks();
  clearAlibabaCliCacheForTests();
});
afterEach(() => vi.useRealTimers());

describe("Alibaba CLI", () => {
  it("extracts only the numeric version from the official CLI banner", async () => {
    reply(`bailian-cli/1.22.0 linux-x64 ${secret}`);
    reply(JSON.stringify(usage));
    const result = await probeAlibabaCliUsage();
    expect(result.version).toBe("1.22.0");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("uses literal arguments, bounded output and timeouts without a shell", async () => {
    reply("1.22.0");
    reply(JSON.stringify({ ...usage, credential: secret }));
    const result = await probeAlibabaCliUsage({
      binaryPath: "/native bl",
      consoleRegion: "ap-southeast-1",
      consoleSite: "international",
    });
    expect(result.usage).toEqual({
      per5Hour: { percentUsed: 0 },
      per1Week: { percentUsed: 1, resetTimeMs: usage.per1WeekResetTime },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      "/native bl",
      [
        "usage",
        "token-plan",
        "--output",
        "json",
        "--timeout",
        "8",
        "--console-region",
        "ap-southeast-1",
        "--console-site",
        "international",
      ],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576, killSignal: "SIGKILL" },
      expect.any(Function),
    );
    expect(buildBlCommandInvocation("bl.cmd", ["%SECRET% & whoami"])).toEqual({
      file: "bl.cmd",
      args: ["%SECRET% & whoami"],
      display: "bl",
    });
  });

  it.each([
    3,
    5,
    6,
    1,
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  ])("never leaks error payloads for exit %s", async (code) => {
    reply("1.22.0");
    reply(secret, code, JSON.stringify({ error: { message: secret } }));
    const result = await probeAlibabaCliUsage();
    expect(result.failureReason).toBe(
      ({ 3: "not_authenticated", 5: "timeout", 6: "network" } as Record<string, string>)[code] ??
        "error",
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    "ETIMEDOUT",
    "ENOENT",
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  ])("does not launch usage after failed version check %s", async (code) => {
    reply(secret, code);
    const result = await probeAlibabaCliUsage({ binaryPath: secret });
    expect(result.failureReason).toBe(
      code === "ENOENT" ? "not_installed" : code === "ETIMEDOUT" ? "timeout" : "error",
    );
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("handles thrown spawn errors with a fixed message", async () => {
    vi.mocked(execFile).mockImplementationOnce(() => {
      throw new Error(secret);
    });
    expect(await probeAlibabaCliUsage()).toMatchObject({
      failureReason: "error",
      message: "Could not run Alibaba Cloud CLI.",
    });
  });

  it.each([
    secret,
    "[]",
    "null",
    "{}",
  ])("rejects invalid or empty quota output %s without echoing it", async (text) => {
    reply("1.22.0");
    reply(text);
    const result = await probeAlibabaCliUsage();
    expect(result.failureReason).toBe(text === "{}" ? "no_data" : "invalid_output");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("accepts weekly-only data and ignores invalid fractions and reset times", () => {
    expect(parseBlTokenPlanUsageJson('{"per1WeekPercentage":0.25}')).toEqual({
      per1Week: { percentUsed: 0.25 },
    });
    for (const value of [-1, 1.01, "0.5", null]) {
      expect(parseBlTokenPlanUsageJson(JSON.stringify({ per5HourPercentage: value }))).toEqual({});
    }
    expect(parseBlTokenPlanUsageJson('{"per5HourPercentage":0.5,"per5HourResetTime":-1}')).toEqual({
      per5Hour: { percentUsed: 0.5 },
    });
  });

  it("deduplicates in-flight work even with zero TTL and caches successes", async () => {
    let complete: any;
    vi.mocked(execFile).mockImplementationOnce(((
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: any,
    ) => {
      complete = callback;
    }) as any);
    const first = probeAlibabaCliUsage({ maxAgeMs: 0 });
    const second = probeAlibabaCliUsage({ maxAgeMs: 0 });
    reply(JSON.stringify(usage));
    complete(null, "1.22.0", "");
    expect(await first).toEqual(await second);
    await probeAlibabaCliUsage();
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("expires failures and separates console options", async () => {
    vi.useFakeTimers();
    reply("", "ENOENT");
    await probeAlibabaCliUsage();
    await probeAlibabaCliUsage();
    expect(execFile).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    reply("", "ENOENT");
    await probeAlibabaCliUsage();
    reply("", "ENOENT");
    await probeAlibabaCliUsage({ consoleSite: "international" });
    expect(execFile).toHaveBeenCalledTimes(3);
  });
});
