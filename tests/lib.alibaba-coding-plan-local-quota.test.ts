import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

  it("counts each completed assistant model-loop step across tool continuation", async () => {
    const { readAlibabaCodingPlanQuotaState } =
      await import("../src/lib/alibaba-coding-plan-local-quota.js");
    const state = await readAlibabaCodingPlanQuotaState({
      nowMs: NOW,
      readMessages: async () => [
        message("assistant-before-tool", "alibaba-coding-plan", NOW - 30_000),
        message("assistant-after-tool", "alibaba-coding-plan", NOW - 10_000),
        message("other-provider", "other", NOW - 500),
      ],
      writeState: async () => undefined,
    });

    expect(state.recent).toEqual([NOW - 30_000, NOW - 10_000]);
  });

  it("derives concurrent sessions without read-modify-write count loss", async () => {
    const { readAlibabaCodingPlanQuotaState } =
      await import("../src/lib/alibaba-coding-plan-local-quota.js");
    const authoritativeRows = [
      message("session-one", "alibaba-coding-plan", NOW - 2_000, "ses_one"),
      message("session-two", "alibaba-coding-plan", NOW - 1_000, "ses_two"),
    ];

    const states = await Promise.all([
      readAlibabaCodingPlanQuotaState({
        nowMs: NOW,
        readMessages: async () => authoritativeRows,
        writeState: async () => undefined,
      }),
      readAlibabaCodingPlanQuotaState({
        nowMs: NOW,
        readMessages: async () => authoritativeRows,
        writeState: async () => undefined,
      }),
    ]);

    expect(states.map((state) => state.recent.length)).toEqual([2, 2]);
  });

  it("derives and computes Alibaba rolling windows from completed rows", async () => {
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } =
      await import("../src/lib/alibaba-coding-plan-local-quota.js");
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
    const { computeAlibabaCodingPlanQuota } =
      await import("../src/lib/alibaba-coding-plan-local-quota.js");
    const quota = computeAlibabaCodingPlanQuota({
      nowMs: NOW,
      tier: "pro",
      state: { version: 1, recent, updatedAt: NOW },
    });

    expect(quota.monthly.used).toBe(90_000);
    expect(quota.monthly.percentRemaining).toBe(0);
  });
});
