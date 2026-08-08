import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { QuotaResetProviderResult } from "../src/lib/quota-reset-notifications.js";
import {
  formatQuotaResetNotification,
  observeQuotaResetNotifications,
} from "../src/lib/quota-reset-notifications.js";

const created: string[] = [];

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-reset-"));
  created.push(root);
  return join(root, "state.json");
}

function provider(params: {
  percentRemaining: number;
  resetAtMs: number;
  sourceId?: string;
  label?: string;
  resultType?: "quota" | "usage";
}): QuotaResetProviderResult {
  return {
    providerId: "openai",
    result: {
      attempted: true,
      errors: [],
      entries: [
        {
          name: "OpenAI",
          group: params.sourceId ? `OpenAI (${params.sourceId})` : "OpenAI",
          label: params.label ?? "7d",
          percentRemaining: params.percentRemaining,
          resetTimeIso: new Date(params.resetAtMs).toISOString(),
          accounting: {
            resultType: params.resultType ?? "quota",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
            sourceId: params.sourceId,
          },
        },
      ],
    },
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("quota reset notifications", () => {
  it("uses the first observation as a baseline and notifies once after a crossed weekly reset", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const firstReset = start + 60 * 60 * 1000;
    const nextReset = firstReset + 7 * 24 * 60 * 60 * 1000;

    expect(
      await observeQuotaResetNotifications({
        providers: [provider({ percentRemaining: 12, resetAtMs: firstReset })],
        windows: ["weekly"],
        nowMs: start,
        statePath: path,
      }),
    ).toEqual([]);

    const notices = await observeQuotaResetNotifications({
      providers: [provider({ percentRemaining: 100, resetAtMs: nextReset })],
      windows: ["weekly"],
      nowMs: firstReset + 60_000,
      statePath: path,
    });
    expect(notices).toEqual([
      {
        providerId: "openai",
        label: "OpenAI",
        window: "weekly",
        percentRemaining: 100,
      },
    ]);
    expect(formatQuotaResetNotification(notices)).toBe(
      "Weekly quota reset: OpenAI is available again (100% remaining).",
    );

    expect(
      await observeQuotaResetNotifications({
        providers: [provider({ percentRemaining: 100, resetAtMs: nextReset })],
        windows: ["weekly"],
        nowMs: firstReset + 120_000,
        statePath: path,
      }),
    ).toEqual([]);
  });

  it("does not notify before the previous reset is crossed or when quota did not improve", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const firstReset = start + 60 * 60 * 1000;
    await observeQuotaResetNotifications({
      providers: [provider({ percentRemaining: 25, resetAtMs: firstReset })],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    expect(
      await observeQuotaResetNotifications({
        providers: [provider({ percentRemaining: 100, resetAtMs: firstReset + 604_800_000 })],
        windows: ["weekly"],
        nowMs: start + 30 * 60 * 1000,
        statePath: path,
      }),
    ).toEqual([]);
  });

  it("filters window and accounting types", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const reset = start + 60 * 60 * 1000;

    await observeQuotaResetNotifications({
      providers: [provider({ percentRemaining: 10, resetAtMs: reset, label: "Monthly" })],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });
    await observeQuotaResetNotifications({
      providers: [provider({ percentRemaining: 10, resetAtMs: reset, resultType: "usage" })],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    expect(JSON.parse(await readFile(path, "utf8")).observations).toEqual({});
  });

  it("keeps accounts independent without persisting source identifiers", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const reset = start + 60 * 60 * 1000;
    const sources = ["work@example.com", "personal@example.com"];

    await observeQuotaResetNotifications({
      providers: sources.map((sourceId) =>
        provider({ percentRemaining: 5, resetAtMs: reset, sourceId }),
      ),
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    const state = await readFile(path, "utf8");
    expect(Object.keys(JSON.parse(state).observations)).toHaveLength(2);
    expect(state).not.toContain("work@example.com");
    expect(state).not.toContain("personal@example.com");
  });
});
