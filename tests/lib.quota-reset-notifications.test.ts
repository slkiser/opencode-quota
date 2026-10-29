import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
  providerId?: string;
  sourceId?: string;
  name?: string;
  group?: string;
  label?: string;
  resultType?: "quota" | "usage";
}): QuotaResetProviderResult {
  const providerId = params.providerId ?? "openai";
  const name = params.name ?? (providerId === "openai" ? "OpenAI" : "Anthropic");
  return {
    providerId,
    result: {
      attempted: true,
      errors: [],
      entries: [
        {
          name,
          group: params.group ?? (params.sourceId ? `${name} (${params.sourceId})` : name),
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
  it("uses the first observation as a baseline and persists one acknowledgement", async () => {
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

  it("reclaims a lock left by an exited process", async () => {
    const path = await statePath();
    const lockPath = `${path}.lock`;
    await mkdir(lockPath, { mode: 0o700 });
    const exitedOwner = spawn(process.execPath, ["-e", ""]);
    const exitedPid = exitedOwner.pid;
    if (!exitedPid) throw new Error("Failed to start lock-owner test process");
    await once(exitedOwner, "exit");
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ token: "exited-owner", pid: exitedPid, createdAtMs: Date.now() }),
    );

    const start = Date.UTC(2026, 0, 1, 12);
    await observeQuotaResetNotifications({
      providers: [provider({ percentRemaining: 10, resetAtMs: start + 60 * 60 * 1000 })],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    expect(Object.keys(JSON.parse(await readFile(path, "utf8")).observations)).toHaveLength(1);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent observers so the same reset is notified once", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const firstReset = start + 60 * 60 * 1000;
    const nextReset = firstReset + 7 * 24 * 60 * 60 * 1000;
    await observeQuotaResetNotifications({
      providers: [provider({ percentRemaining: 10, resetAtMs: firstReset })],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    const results = await Promise.all(
      [1, 2].map(() =>
        observeQuotaResetNotifications({
          providers: [provider({ percentRemaining: 100, resetAtMs: nextReset })],
          windows: ["weekly"],
          nowMs: firstReset + 60_000,
          statePath: path,
        }),
      ),
    );

    expect(results.flat()).toHaveLength(1);
  });

  it("preserves disjoint observations written concurrently", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const reset = start + 60 * 60 * 1000;

    await Promise.all(
      ["work@example.com", "personal@example.com"].map((sourceId) =>
        observeQuotaResetNotifications({
          providers: [provider({ percentRemaining: 5, resetAtMs: reset, sourceId })],
          windows: ["weekly"],
          nowMs: start,
          statePath: path,
        }),
      ),
    );

    const state = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(state.observations)).toHaveLength(2);
  });

  it("preserves a pre-boundary baseline while a provider still reports the expired reset", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const firstReset = start + 60 * 60 * 1000;
    const nextReset = firstReset + 7 * 24 * 60 * 60 * 1000;
    await observeQuotaResetNotifications({
      providers: [provider({ percentRemaining: 10, resetAtMs: firstReset })],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    await observeQuotaResetNotifications({
      providers: [provider({ percentRemaining: 10, resetAtMs: firstReset })],
      windows: ["weekly"],
      nowMs: firstReset + 60_000,
      statePath: path,
    });

    expect(
      await observeQuotaResetNotifications({
        providers: [provider({ percentRemaining: 100, resetAtMs: nextReset })],
        windows: ["weekly"],
        nowMs: firstReset + 120_000,
        statePath: path,
      }),
    ).toHaveLength(1);
  });

  it("keeps identity stable when presentation labels change", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const firstReset = start + 60 * 60 * 1000;
    const nextReset = firstReset + 7 * 24 * 60 * 60 * 1000;
    await observeQuotaResetNotifications({
      providers: [
        provider({
          percentRemaining: 10,
          resetAtMs: firstReset,
          sourceId: "account-1",
          name: "Old provider name",
          group: "Old account label",
          label: "7d",
        }),
      ],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    const notices = await observeQuotaResetNotifications({
      providers: [
        provider({
          percentRemaining: 100,
          resetAtMs: nextReset,
          sourceId: "account-1",
          name: "New provider name",
          group: "New account label",
          label: "weekly",
        }),
      ],
      windows: ["weekly"],
      nowMs: firstReset + 60_000,
      statePath: path,
    });

    expect(notices).toEqual([
      expect.objectContaining({ providerId: "openai", label: "New account label" }),
    ]);
  });

  it("skips ambiguous rows instead of attributing one series to another", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const reset = start + 60 * 60 * 1000;

    await observeQuotaResetNotifications({
      providers: [
        provider({ percentRemaining: 5, resetAtMs: reset, name: "First" }),
        provider({ percentRemaining: 15, resetAtMs: reset, name: "Second" }),
      ],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    expect(JSON.parse(await readFile(path, "utf8")).observations).toEqual({});
  });

  it("aggregates providers that reset together", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const firstReset = start + 60 * 60 * 1000;
    const nextReset = firstReset + 7 * 24 * 60 * 60 * 1000;
    const initial = [
      provider({ percentRemaining: 5, resetAtMs: firstReset, providerId: "openai" }),
      provider({ percentRemaining: 15, resetAtMs: firstReset, providerId: "anthropic" }),
    ];
    await observeQuotaResetNotifications({
      providers: initial,
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    const notices = await observeQuotaResetNotifications({
      providers: [
        provider({ percentRemaining: 100, resetAtMs: nextReset, providerId: "openai" }),
        provider({ percentRemaining: 100, resetAtMs: nextReset, providerId: "anthropic" }),
      ],
      windows: ["weekly"],
      nowMs: firstReset + 60_000,
      statePath: path,
    });

    expect(notices).toHaveLength(2);
    expect(formatQuotaResetNotification(notices)).toBe(
      "Quota reset: OpenAI, Anthropic are available again.",
    );
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

  it("limits structured reset observations to typed-window quota and rate-limit percentages", async () => {
    const path = await statePath();
    const start = Date.UTC(2026, 0, 1, 12);
    const reset = start + 60 * 60 * 1000;
    const accounting = {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    } as const;

    await observeQuotaResetNotifications({
      providers: [
        {
          providerId: "openai",
          result: {
            attempted: true,
            errors: [],
            entries: [
              {
                kind: "quantity",
                accounting: { ...accounting, resultType: "balance" },
                semantic: {
                  metric: { kind: "component", component: "current_balance" },
                  prominence: "primary",
                },
                name: "Balance",
                quantity: { decimal: "10", unit: { kind: "currency", code: "USD" } },
                resetTimeIso: new Date(reset).toISOString(),
              },
              {
                kind: "boolean",
                accounting: { ...accounting, resultType: "status" },
                semantic: {
                  metric: { kind: "component", component: "auto_reload" },
                  prominence: "supplementary",
                },
                name: "Auto-reload",
                value: true,
                resetTimeIso: new Date(reset).toISOString(),
              },
              {
                accounting: { ...accounting, resultType: "budget" },
                semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
                name: "Budget",
                percentRemaining: 10,
                resetTimeIso: new Date(reset).toISOString(),
              },
              {
                accounting,
                semantic: { metric: { kind: "aggregate" }, prominence: "primary" },
                name: "Aggregate quota",
                label: "Weekly:",
                percentRemaining: 10,
                resetTimeIso: new Date(reset).toISOString(),
              },
              {
                accounting: { ...accounting, sourceId: "quota" },
                semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
                name: "Typed quota",
                label: "Monthly:",
                percentRemaining: 10,
                resetTimeIso: new Date(reset).toISOString(),
              },
              {
                accounting: { ...accounting, resultType: "rate_limit", sourceId: "rate" },
                semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
                name: "Typed rate limit",
                label: "Monthly:",
                percentRemaining: 20,
                resetTimeIso: new Date(reset).toISOString(),
              },
              {
                accounting: { ...accounting, sourceId: "monthly" },
                semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
                name: "Typed monthly quota",
                label: "Weekly:",
                percentRemaining: 30,
                resetTimeIso: new Date(reset).toISOString(),
              },
            ],
          },
        },
      ],
      windows: ["weekly"],
      nowMs: start,
      statePath: path,
    });

    expect(Object.keys(JSON.parse(await readFile(path, "utf8")).observations)).toHaveLength(2);
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
