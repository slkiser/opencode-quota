import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/home/test/.local/share/opencode",
    configDir: "/home/test/.config/opencode",
    cacheDir: "/home/test/.cache/opencode",
    stateDir: "/home/test/.local/state/opencode",
  }),
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

describe("qwen-local-quota", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a default state when file is missing", async () => {
    vi.setSystemTime(new Date("2026-02-24T12:00:00.000Z"));
    const fs = await import("fs/promises");
    (fs.readFile as any).mockRejectedValueOnce(new Error("missing"));

    const { computeQwenQuota, readQwenLocalQuotaState } = await import("../src/lib/qwen-local-quota.js");
    const state = await readQwenLocalQuotaState();
    const quota = computeQwenQuota({ state });

    expect(state.utcDay).toBe("2026-02-24");
    expect(state.dayCount).toBe(0);
    expect(state.recent).toEqual([]);
    expect(quota.day.used).toBe(0);
    expect(quota.day.percentRemaining).toBe(100);
    expect(quota.rpm.used).toBe(0);
    expect(quota.rpm.percentRemaining).toBe(100);
    expect(quota.day.resetTimeIso).toBe("2026-02-25T00:00:00.000Z");
  });

  it("resets day counter at UTC midnight when recording a completion", async () => {
    vi.setSystemTime(new Date("2026-02-24T00:00:10.000Z"));
    const fs = await import("fs/promises");

    (fs.readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        utcDay: "2026-02-23",
        dayCount: 42,
        recent: [Date.now() - 10_000],
        updatedAt: Date.now() - 60_000,
      }),
    );

    const { recordQwenCompletion } = await import("../src/lib/qwen-local-quota.js");
    const next = await recordQwenCompletion();

    expect(next.utcDay).toBe("2026-02-24");
    expect(next.dayCount).toBe(1);
    expect(next.recent.length).toBe(2);

    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const [, payload] = (fs.writeFile as any).mock.calls[0];
    const persisted = JSON.parse(payload as string);
    expect(persisted.dayCount).toBe(1);
    expect(persisted.utcDay).toBe("2026-02-24");
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });

  it("computes RPM from timestamps in the last 60 seconds", async () => {
    vi.setSystemTime(new Date("2026-02-24T12:00:00.000Z"));

    const now = Date.now();
    const { computeQwenQuota } = await import("../src/lib/qwen-local-quota.js");
    const quota = computeQwenQuota({
      nowMs: now,
      state: {
        version: 1,
        utcDay: "2026-02-24",
        dayCount: 50,
        recent: [now - 61_000, now - 30_000, now - 1_000],
        updatedAt: now,
      },
    });

    expect(quota.rpm.used).toBe(2);
    expect(quota.rpm.limit).toBe(60);
    expect(quota.rpm.percentRemaining).toBe(97);
    expect(quota.rpm.resetTimeIso).toBe(new Date(now - 30_000 + 60_000).toISOString());
  });

  it("replaces destination when rename fails on existing file", async () => {
    vi.setSystemTime(new Date("2026-02-24T12:00:00.000Z"));
    const fs = await import("fs/promises");
    const now = Date.now();

    (fs.readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        utcDay: "2026-02-24",
        dayCount: 3,
        recent: [now - 20_000],
        updatedAt: now - 20_000,
      }),
    );

    const renameError = Object.assign(new Error("destination exists"), { code: "EPERM" });
    (fs.rename as any).mockRejectedValueOnce(renameError).mockResolvedValueOnce(undefined);

    const { recordQwenCompletion } = await import("../src/lib/qwen-local-quota.js");
    const next = await recordQwenCompletion();

    expect(next.dayCount).toBe(4);
    expect(fs.rm).toHaveBeenCalledTimes(1);
    expect(fs.rename).toHaveBeenCalledTimes(2);
  });
});
