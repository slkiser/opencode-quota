import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  QUOTA_PROVIDER_LOCAL_STATE_VERSION,
  __resetLocalQuotaProviderStateForTests,
  computeLocalQuotaProviderEstimate,
  getLocalQuotaProviderStatePath,
  inspectLocalQuotaProviderState,
  syncLocalQuotaProviderState,
} from "../src/lib/quota-providers-local.js";
import type { LocalEstimateQuotaProviderDefinition } from "../src/lib/quota-providers.js";
import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";

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
      {
        id: "daily",
        label: "Daily",
        type: "utc-day",
        requestLimit: 10,
        usdBudget: 5,
      },
      {
        id: "rolling",
        label: "Rolling",
        type: "rolling",
        durationMinutes: 60,
        requestLimit: 5,
      },
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
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  };
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

afterEach(async () => {
  __resetLocalQuotaProviderStateForTests();
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

    await syncLocalQuotaProviderState(def, {
      nowMs: NOW,
      runtimeDirs: dirs,
      readMessages: async () => [message("msg_1", NOW - 1000)],
    });

    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toMatchObject({
      version: QUOTA_PROVIDER_LOCAL_STATE_VERSION,
      definitionId: "private-gateway",
      providerId: "private-gateway",
      updatedAt: NOW,
    });
    const diagnostic = await inspectLocalQuotaProviderState(def, { runtimeDirs: dirs });
    expect(diagnostic).toEqual({
      path,
      exists: true,
      health: "healthy",
      version: QUOTA_PROVIDER_LOCAL_STATE_VERSION,
      lastUpdatedAt: NOW,
    });
  });

  it("deduplicates message ids and prunes records outside the longest declared window", async () => {
    const dirs = await runtimeDirs();
    const def = definition();
    const state = await syncLocalQuotaProviderState(def, {
      nowMs: NOW,
      runtimeDirs: dirs,
      readMessages: async () => [
        message("duplicate", NOW - 1000),
        message("duplicate", NOW - 500),
        message("old", NOW - 2 * 24 * 60 * 60 * 1000),
        message("other-provider", NOW - 100, { providerID: "other" }),
      ],
    });
    expect(state.messages.map((item) => item.id)).toEqual(["duplicate"]);
    expect(state.messages[0]?.atMs).toBe(NOW - 500);
  });

  it("serializes concurrent updates so distinct completions are not lost", async () => {
    const dirs = await runtimeDirs();
    const def = definition();
    let call = 0;
    const readMessages = async () => {
      call += 1;
      return [message("msg_" + call, NOW - call)];
    };

    await Promise.all([
      syncLocalQuotaProviderState(def, {
        nowMs: NOW,
        runtimeDirs: dirs,
        readMessages,
      }),
      syncLocalQuotaProviderState(def, {
        nowMs: NOW,
        runtimeDirs: dirs,
        readMessages,
      }),
    ]);

    const raw = JSON.parse(await readFile(getLocalQuotaProviderStatePath(def.id, dirs), "utf8"));
    expect(raw.messages.map((item: { id: string }) => item.id).sort()).toEqual(["msg_1", "msg_2"]);
  });

  it("does not replace the prior file when an atomic write fails", async () => {
    const dirs = await runtimeDirs();
    const def = definition();
    const path = getLocalQuotaProviderStatePath(def.id, dirs);
    await syncLocalQuotaProviderState(def, {
      nowMs: NOW,
      runtimeDirs: dirs,
      readMessages: async () => [message("existing", NOW - 1000)],
    });
    const before = await readFile(path, "utf8");

    await expect(
      syncLocalQuotaProviderState(def, {
        nowMs: NOW + 1000,
        runtimeDirs: dirs,
        readMessages: async () => [message("new", NOW)],
        writeState: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("recovers malformed state by rebuilding it from read-only OpenCode messages", async () => {
    const dirs = await runtimeDirs();
    const def = definition();
    const path = getLocalQuotaProviderStatePath(def.id, dirs);
    await writeFile(path, "{not-json", { encoding: "utf8", flag: "w" }).catch(async () => {
      await syncLocalQuotaProviderState(def, {
        nowMs: NOW,
        runtimeDirs: dirs,
        readMessages: async () => [],
      });
      await writeFile(path, "{not-json", "utf8");
    });

    const state = await syncLocalQuotaProviderState(def, {
      nowMs: NOW,
      runtimeDirs: dirs,
      readMessages: async () => [message("recovered", NOW - 100)],
    });
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
    const state = {
      version: QUOTA_PROVIDER_LOCAL_STATE_VERSION,
      definitionId: def.id,
      providerId: def.providerId,
      updatedAt: NOW,
      messages: [
        {
          id: "priced",
          atMs: NOW - 1000,
          providerId: "openai",
          modelId: "gpt-4o",
          tokens: {
            input: 1_000_000,
            output: 0,
            reasoning: 0,
            cache_read: 0,
            cache_write: 0,
          },
        },
      ],
    } as const;

    const result = computeLocalQuotaProviderEstimate({ definition: def, state, nowMs: NOW });
    const budget = result.entries.find((entry) => entry.accounting.resultType === "budget");
    expect(budget?.kind).toBe("percent");
    expect(result.unpricedMessageCount).toBe(0);
  });

  it("keeps request counts but never emits a budget percentage for unpriced usage", () => {
    const def = definition();
    const state = {
      version: QUOTA_PROVIDER_LOCAL_STATE_VERSION,
      definitionId: def.id,
      providerId: def.providerId,
      updatedAt: NOW,
      messages: [
        {
          id: "unpriced",
          atMs: NOW - 1000,
          providerId: def.providerId,
          modelId: "unknown-private-model",
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache_read: 0,
            cache_write: 0,
          },
        },
      ],
    } as const;

    const result = computeLocalQuotaProviderEstimate({ definition: def, state, nowMs: NOW });
    const request = result.entries.find((entry) => entry.accounting.resultType === "rate_limit");
    const budget = result.entries.find((entry) => entry.accounting.resultType === "budget");
    expect(request).toMatchObject({ kind: "percent", right: "1/10" });
    expect(budget).toMatchObject({
      kind: "value",
      value: "Unavailable (1 unpriced request)",
    });
    expect(result.unpricedMessageCount).toBe(1);
  });
});
