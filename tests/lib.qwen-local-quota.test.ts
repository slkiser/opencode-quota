import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/home/test/.local/share/opencode",
    configDir: "/home/test/.config/opencode",
    cacheDir: "/home/test/.cache/opencode",
    stateDir: "/home/test/.local/state/opencode",
  }),
}));

const NOW = Date.parse("2026-02-24T12:00:00.000Z");

function message(
  id: string,
  providerID: string,
  completed: number | undefined,
  sessionID = "ses_one",
): OpenCodeMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    providerID,
    modelID: "model",
    time: {
      created: NOW - 24 * 60 * 60 * 1000,
      ...(completed === undefined ? {} : { completed }),
    },
  };
}

describe("maintained local quota storage derivation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });

  it("counts a normal completed Qwen response and never counts unfinished rows", async () => {
    const writes: unknown[] = [];
    const { computeQwenQuota, readQwenLocalQuotaState } =
      await import("../src/lib/qwen-local-quota.js");
    const state = await readQwenLocalQuotaState({
      nowMs: NOW,
      readMessages: async () => [
        message("complete", "qwen-code", NOW - 1_000),
        message("unfinished", "qwen-code", undefined),
        message("other-provider", "other", NOW - 500),
      ],
      writeState: async (_path, value) => {
        writes.push(value);
      },
    });

    expect(state).toMatchObject({
      utcDay: "2026-02-24",
      dayCount: 1,
      recent: [NOW - 1_000],
      updatedAt: NOW,
    });
    expect(computeQwenQuota({ state, nowMs: NOW }).day.used).toBe(1);
    expect(writes).toEqual([state]);
  });

  it("counts each completed assistant model-loop step across tool continuation", async () => {
    const { readQwenLocalQuotaState } = await import("../src/lib/qwen-local-quota.js");
    const state = await readQwenLocalQuotaState({
      nowMs: NOW,
      readMessages: async () => [
        message("assistant-before-tool", "qwen-code", NOW - 30_000),
        message("assistant-after-tool", "qwen-code", NOW - 10_000),
      ],
      writeState: async () => undefined,
    });

    expect(state.dayCount).toBe(2);
    expect(state.recent).toEqual([NOW - 30_000, NOW - 10_000]);
  });

  it("derives concurrent sessions without read-modify-write count loss", async () => {
    const { readQwenLocalQuotaState } = await import("../src/lib/qwen-local-quota.js");
    const authoritativeRows = [
      message("session-one", "qwen-code", NOW - 2_000, "ses_one"),
      message("session-two", "qwen-code", NOW - 1_000, "ses_two"),
    ];

    const states = await Promise.all([
      readQwenLocalQuotaState({
        nowMs: NOW,
        readMessages: async () => authoritativeRows,
        writeState: async () => undefined,
      }),
      readQwenLocalQuotaState({
        nowMs: NOW,
        readMessages: async () => authoritativeRows,
        writeState: async () => undefined,
      }),
    ]);

    expect(states.map((state) => state.dayCount)).toEqual([2, 2]);
  });

  it("uses UTC completion cutoffs even when creation is before midnight", async () => {
    const utcStart = Date.parse("2026-02-24T00:00:00.000Z");
    let requestedSince = 0;
    const { readQwenLocalQuotaState } = await import("../src/lib/qwen-local-quota.js");
    const state = await readQwenLocalQuotaState({
      nowMs: NOW,
      readMessages: async ({ completedSinceMs }) => {
        requestedSince = completedSinceMs;
        return [
          {
            ...message("cross-cutoff", "qwen-code", utcStart + 1),
            time: { created: utcStart - 60_000, completed: utcStart + 1 },
          },
          message("before-cutoff", "qwen-code", utcStart - 1),
        ];
      },
      writeState: async () => undefined,
    });

    expect(requestedSince).toBe(utcStart);
    expect(state.dayCount).toBe(1);
  });

  it("computes RPM from completed timestamps in the last 60 seconds", async () => {
    const { computeQwenQuota } = await import("../src/lib/qwen-local-quota.js");
    const quota = computeQwenQuota({
      nowMs: NOW,
      state: {
        version: 1,
        utcDay: "2026-02-24",
        dayCount: 50,
        recent: [NOW - 61_000, NOW - 30_000, NOW - 1_000],
        updatedAt: NOW,
      },
    });

    expect(quota.rpm.used).toBe(2);
    expect(quota.rpm.limit).toBe(60);
    expect(quota.rpm.resetTimeIso).toBe(new Date(NOW - 30_000 + 60_000).toISOString());
  });

  it("derives and computes Alibaba rolling windows from completed rows", async () => {
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } =
      await import("../src/lib/qwen-local-quota.js");
    const state = await readAlibabaCodingPlanQuotaState({
      nowMs: NOW,
      readMessages: async () => [
        message("six-days", "alibaba-coding-plan", NOW - 6 * 24 * 60 * 60 * 1000),
        message("one-hour", "alibaba-coding-plan", NOW - 60 * 60 * 1000),
        message("five-minutes", "alibaba-coding-plan", NOW - 5 * 60 * 1000),
        message("unfinished", "alibaba-coding-plan", undefined),
      ],
      writeState: async () => undefined,
    });
    const quota = computeAlibabaCodingPlanQuota({ nowMs: NOW, tier: "lite", state });

    expect(quota.fiveHour.used).toBe(2);
    expect(quota.weekly.used).toBe(3);
    expect(quota.monthly.used).toBe(3);
  });

  it("computes a valid 90,000-request Alibaba monthly state", async () => {
    const recent = Array.from({ length: 90_000 }, (_, index) => NOW - index * 1_000);
    const { computeAlibabaCodingPlanQuota } = await import("../src/lib/qwen-local-quota.js");
    const quota = computeAlibabaCodingPlanQuota({
      nowMs: NOW,
      tier: "pro",
      state: { version: 1, recent, updatedAt: NOW },
    });

    expect(quota.monthly.used).toBe(90_000);
    expect(quota.monthly.percentRemaining).toBe(0);
  });
});
