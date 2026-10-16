import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";
import {
  computeLocalQuotaProviderEstimate,
  getLocalQuotaProviderStatePath,
  inspectLocalQuotaProviderState,
  type LocalQuotaProviderStateV1,
  syncLocalQuotaProviderState,
} from "../src/lib/quota-providers-local.js";
import type { LocalEstimateQuotaProviderDefinition } from "../src/lib/quota-providers.js";

const created: string[] = [];
const NOW = Date.UTC(2026, 6, 16, 12, 0, 0);

function definition(
  overrides: Partial<LocalEstimateQuotaProviderDefinition> = {},
): LocalEstimateQuotaProviderDefinition {
  return {
    id: "private-gateway",
    providerId: "private-gateway",
    label: "Private Gateway",
    mode: "local-estimate",
    windows: [
      { id: "daily", label: "Daily", type: "utc-day", requestLimit: 10, usdBudget: 5 },
      { id: "rolling", label: "Rolling", type: "rolling", durationMinutes: 60, requestLimit: 5 },
    ],
    ...overrides,
  };
}

function message(
  id: string,
  atMs: number,
  overrides: Partial<OpenCodeMessage> = {},
): OpenCodeMessage {
  return {
    id,
    sessionID: "ses_test",
    role: "assistant",
    providerID: "private-gateway",
    modelID: "private-model",
    time: { created: atMs, completed: atMs },
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

/** The estimate at NOW from a state file holding these stored messages. */
function estimate(
  def: LocalEstimateQuotaProviderDefinition,
  messages: Array<{ id: string; atMs: number; modelId: string; input: number; output: number }>,
) {
  const state: LocalQuotaProviderStateV1 = {
    version: 1,
    definitionId: def.id,
    providerId: def.providerId,
    updatedAt: NOW,
    messages: messages.map(({ id, atMs, modelId, input, output }) => ({
      id,
      atMs,
      providerId: def.providerId,
      modelId,
      tokens: { input, output, reasoning: 0, cache_read: 0, cache_write: 0 },
    })),
  };
  return computeLocalQuotaProviderEstimate({ definition: def, state, nowMs: NOW });
}

async function runtimeDirs() {
  const root = await mkdtemp(join(tmpdir(), "quota-providers-local-"));
  created.push(root);
  return {
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    cacheDir: join(root, "cache"),
    stateDir: join(root, "state"),
  };
}

/** Syncs the default definition's state at NOW from these OpenCode messages. */
function sync(
  dirs: Awaited<ReturnType<typeof runtimeDirs>>,
  messages: OpenCodeMessage[],
  options: Partial<Parameters<typeof syncLocalQuotaProviderState>[1]> = {},
) {
  return syncLocalQuotaProviderState(definition(), {
    nowMs: NOW,
    runtimeDirs: dirs,
    readMessages: async () => messages,
    ...options,
  });
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local quota provider state", () => {
  it("uses the exact XDG state path and writes versioned health metadata", async () => {
    const dirs = await runtimeDirs();
    const def = definition();
    const path = getLocalQuotaProviderStatePath(def.id, dirs);
    expect(path).toBe(
      join(dirs.stateDir, "opencode-quota", "quota-providers", "private-gateway.json"),
    );

    await sync(dirs, [message("msg_1", NOW - 1000)]);

    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toMatchObject({
      version: 1,
      definitionId: "private-gateway",
      providerId: "private-gateway",
      updatedAt: NOW,
    });
    const diagnostic = await inspectLocalQuotaProviderState(def, { runtimeDirs: dirs });
    expect(diagnostic).toEqual({
      path,
      exists: true,
      health: "healthy",
      version: 1,
      lastUpdatedAt: NOW,
    });
  });

  it.each([
    ["missing", null, { exists: false, health: "missing", version: null }],
    ["unparseable", "{not-json", { exists: true, health: "malformed", version: null }],
    ["other-version", { version: 2 }, { exists: true, health: "version_mismatch", version: 2 }],
    [
      "other-definition",
      {
        version: 1,
        definitionId: "other",
        providerId: "private-gateway",
        updatedAt: 1,
        messages: [],
      },
      { exists: true, health: "malformed", version: 1 },
    ],
    [
      "bad-message",
      {
        version: 1,
        definitionId: "private-gateway",
        providerId: "private-gateway",
        updatedAt: 1,
        messages: [{ id: "", atMs: 1, providerId: "p", modelId: "m", tokens: {} }],
      },
      { exists: true, health: "malformed", version: 1 },
    ],
  ] as const)("reports %s state files", async (_name, content, expected) => {
    const dirs = await runtimeDirs();
    const diagnostic = await inspectLocalQuotaProviderState(definition(), {
      runtimeDirs: dirs,
      readText: async () => {
        if (content === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return typeof content === "string" ? content : JSON.stringify(content);
      },
    });
    // No file exists on disk, so an unhealthy state has no modification time either.
    expect(diagnostic).toEqual({ ...expected, path: diagnostic.path, lastUpdatedAt: null });
  });

  it("keeps the latest copy of each id, only for this provider, within the longest window", async () => {
    const state = await sync(await runtimeDirs(), [
      message("duplicate", NOW - 1000),
      message("duplicate", NOW - 500),
      message("old", NOW - 2 * 24 * 60 * 60 * 1000),
      message("other-provider", NOW - 100, { providerID: "other" }),
      message("unfinished", NOW - 50, { time: { created: NOW - 50 } }),
    ]);
    expect(state.messages.map((item) => [item.id, item.atMs])).toEqual([["duplicate", NOW - 500]]);
  });

  it("uses completion time for UTC and rolling windows across creation cutoffs", async () => {
    const dirs = await runtimeDirs();
    const utcStart = Date.UTC(2026, 6, 16);
    let requestedSince = 0;
    const state = await syncLocalQuotaProviderState(definition(), {
      nowMs: NOW,
      runtimeDirs: dirs,
      readMessages: async ({ completedSinceMs }) => {
        requestedSince = completedSinceMs;
        return [
          message("cross-cutoff", utcStart - 60_000, {
            time: { created: utcStart - 60_000, completed: NOW - 30_000 },
          }),
          message("completed-before-cutoff", NOW - 10_000, {
            time: { created: NOW - 10_000, completed: utcStart - 1 },
          }),
        ];
      },
    });

    expect(requestedSince).toBe(utcStart);
    expect(state.messages.map((item) => item.id)).toEqual(["cross-cutoff"]);
    const result = computeLocalQuotaProviderEstimate({
      definition: definition(),
      state,
      nowMs: NOW,
    });
    const requests = (decimal: string) => ({ decimal, unit: { kind: "count", unit: "request" } });
    const dailyRow = result.rows.find((row) => row.key === "daily");
    const rollingRow = result.rows.find((row) => row.key === "rolling");
    expect(dailyRow).toMatchObject({
      label: "Daily",
      used: requests("1"),
      limit: requests("10"),
      resetsAt: "2026-07-17T00:00:00.000Z",
      windowStartedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(rollingRow).toMatchObject({
      label: "Rolling",
      used: requests("1"),
      limit: requests("5"),
      resetsAt: new Date(NOW - 30_000 + 60 * 60 * 1000).toISOString(),
    });
    expect(rollingRow).not.toHaveProperty("windowStartedAt");
  });

  it("writes the same complete snapshot when two sessions sync at once", async () => {
    const dirs = await runtimeDirs();
    const messages = [
      message("msg_1", NOW - 2, { sessionID: "ses_one" }),
      message("msg_2", NOW - 1, { sessionID: "ses_two" }),
    ];

    const states = await Promise.all([sync(dirs, messages), sync(dirs, messages)]);

    expect(states.map((state) => state.messages.map((item) => item.id))).toEqual([
      ["msg_1", "msg_2"],
      ["msg_1", "msg_2"],
    ]);
    const raw = JSON.parse(
      await readFile(getLocalQuotaProviderStatePath(definition().id, dirs), "utf8"),
    );
    expect(raw.messages.map((item: { id: string }) => item.id).sort()).toEqual(["msg_1", "msg_2"]);
  });

  it("does not replace the prior file when an atomic write fails", async () => {
    const dirs = await runtimeDirs();
    const path = getLocalQuotaProviderStatePath(definition().id, dirs);
    await sync(dirs, [message("existing", NOW - 1000)]);
    const before = await readFile(path, "utf8");

    await expect(
      sync(dirs, [message("new", NOW)], {
        nowMs: NOW + 1000,
        writeState: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rebuilds a malformed state file from read-only OpenCode messages", async () => {
    const dirs = await runtimeDirs();
    const def = definition();
    const path = getLocalQuotaProviderStatePath(def.id, dirs);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1 }), "utf8");
    // A readable but unhealthy file reports when it was last written.
    expect(await inspectLocalQuotaProviderState(def, { runtimeDirs: dirs })).toMatchObject({
      health: "malformed",
      lastUpdatedAt: expect.any(Number),
    });

    const state = await sync(dirs, [message("recovered", NOW - 100)]);
    expect(state.messages.map((item) => item.id)).toEqual(["recovered"]);
    expect((await inspectLocalQuotaProviderState(def, { runtimeDirs: dirs })).health).toBe(
      "healthy",
    );
  });

  it("prices automatic models.dev matches before manual fallbacks", () => {
    const def = definition({
      id: "openai-local",
      providerId: "openai",
      pricingModelMap: { "gpt-4o": "anthropic/claude-sonnet-4-5" },
    });
    const result = estimate(def, [
      { id: "priced", atMs: NOW - 1000, modelId: "gpt-4o", input: 1_000_000, output: 0 },
    ]);
    const budget = result.rows.find((row) => row.type === "budget");
    expect(budget?.percentRemaining).toBeTypeOf("number");
    expect(result.unpricedMessageCount).toBe(0);
  });

  it("keeps request counts but never emits a budget percentage for unpriced usage", () => {
    const result = estimate(definition(), [
      { id: "unpriced", atMs: NOW - 1000, modelId: "unknown-private-model", input: 10, output: 5 },
    ]);
    const request = result.rows.find((row) => row.type === "quota");
    const budget = result.rows.find((row) => row.type === "budget");
    expect(request).toMatchObject({ percentRemaining: 90, used: { decimal: "1" } });
    expect(budget).toEqual({
      key: "daily_budget",
      label: "Daily budget",
      type: "budget",
      method: "local_estimation",
      authority: "locally_derived",
      prominence: "primary",
      window: "day",
      text: "Unavailable (1 unpriced request)",
      resetsAt: expect.any(String),
    });
    expect(result.unpricedMessageCount).toBe(1);
  });

  it("bounds over-limit request and budget percentages at zero", () => {
    const def = definition({
      pricingModelMap: { "private-model": "openai/gpt-4o" },
      windows: [
        { id: "daily", label: "Daily", type: "utc-day", requestLimit: 1, usdBudget: 0.000001 },
      ],
    });
    const result = estimate(
      def,
      ["one", "two"].map((id, index) => ({
        id,
        atMs: NOW - (2 - index) * 1_000,
        modelId: "private-model",
        input: 1_000,
        output: 1_000,
      })),
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        type: "quota",
        used: { decimal: "2", unit: { kind: "count", unit: "request" } },
        limit: { decimal: "1", unit: { kind: "count", unit: "request" } },
        percentRemaining: 0,
      }),
      expect.objectContaining({
        type: "budget",
        limit: { decimal: "0", unit: { kind: "currency", code: "USD" } },
        percentRemaining: 0,
      }),
    ]);
  });
});
