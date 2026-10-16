import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QuotaRetryEvent } from "../src/lib/quota-retry-wait.js";
import type { ProviderRow } from "../src/providers/contract.js";
import type { LoadedSettings, Settings } from "../src/settings/index.js";
import { answer, percentRow, quotaRow } from "./helpers/fake-answers.js";
import {
  createPluginRuntimePathsMockModule,
  createProvidersRegistryModuleMock,
} from "./helpers/plugin-test-harness.js";

// A fresh folder per run, so test runs in sibling checkouts never share it.
const TEST_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "opencode-quota-retry-wait-"));
const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE_MS = 60_000;

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
}));

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);

// Loaded after the mocks above are set up.
const { defaultSettings } = await import("../src/settings/schema.js");
const {
  getQuotaResetRetryDelayMs,
  isQuotaLimitError,
  QUOTA_RESET_RETRY_BUFFER_MS,
  QUOTA_RESET_RETRY_MAX_DELAY_MS,
} = await import("../src/lib/quota-retry-wait.js");

function at(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

/** A Z.ai row; without a percent it shows a text. */
const row = (key: string, percentRemaining: number | undefined, resetsAt?: string) =>
  quotaRow(`zai.${key}`, {
    ...(percentRemaining === undefined ? { text: "n/a" } : { percentRemaining }),
    ...(resetsAt ? { resetsAt } : {}),
  });

const WINDOW_KEYS = { "5h": "five_hour", Weekly: "weekly" } as const;

function window(label: keyof typeof WINDOW_KEYS, percentRemaining: number, resetsAt: string) {
  return percentRow(WINDOW_KEYS[label], label, percentRemaining, { resetsAt });
}

describe("isQuotaLimitError", () => {
  it("accepts OpenCode's rate-limit and quota errors and any HTTP 429", () => {
    expect(isQuotaLimitError({ type: "provider.rate-limit" })).toBe(true);
    expect(isQuotaLimitError({ type: "provider.quota" })).toBe(true);
    expect(isQuotaLimitError({ type: "provider.unknown", status: 429 })).toBe(true);
  });

  it("rejects other errors", () => {
    for (const type of ["provider.auth", "provider.transport", "provider.internal", "unknown"]) {
      expect(isQuotaLimitError({ type, status: 500 })).toBe(false);
    }
  });
});

describe("getQuotaResetRetryDelayMs", () => {
  it("waits until a used-up window resets, plus the buffer", () => {
    const delay = getQuotaResetRetryDelayMs(
      [row("five_hour", 0, at(90 * MINUTE_MS)), row("weekly", 40, at(MINUTE_MS))],
      NOW_MS,
    );
    expect(delay).toBe(90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("picks the earliest reset among used-up windows", () => {
    const delay = getQuotaResetRetryDelayMs(
      [row("five_hour", 0, at(90 * MINUTE_MS)), row("hourly", -2, at(20 * MINUTE_MS))],
      NOW_MS,
    );
    expect(delay).toBe(20 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("caps the wait", () => {
    const delay = getQuotaResetRetryDelayMs(
      [row("weekly", 0, at(3 * 24 * 60 * MINUTE_MS))],
      NOW_MS,
    );
    expect(delay).toBe(QUOTA_RESET_RETRY_MAX_DELAY_MS);
    expect(QUOTA_RESET_RETRY_MAX_DELAY_MS).toBe(5 * 60 * MINUTE_MS);
  });

  it("has no delay without a used-up window whose reset is still ahead", () => {
    expect(getQuotaResetRetryDelayMs([], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 3, at(90 * MINUTE_MS))], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 0, at(-MINUTE_MS))], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 0, at(0))], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 0)], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 0, "not a date")], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", undefined, at(MINUTE_MS))], NOW_MS)).toBeUndefined();
  });
});

describe("resolveQuotaResetRetryDelayMs", () => {
  const limitEvent: QuotaRetryEvent = {
    model: { id: "glm-4.6", providerID: "zai-coding-plan" },
    error: { type: "provider.quota", status: 429 },
  };

  function makeProvider(id: string, rows: ProviderRow[], matches: (model: string) => boolean) {
    return {
      id,
      isAvailable: vi.fn().mockResolvedValue(true),
      matchesCurrentModel: vi.fn(matches),
      fetch: vi.fn().mockResolvedValue(answer({ name: id, rows })),
    };
  }

  let current: LoadedSettings;
  /** The server settings: the defaults with `edit` applied. */
  function useSettings(edit: (settings: Settings) => void): void {
    const settings = defaultSettings();
    edit(settings);
    current = {
      path: "settings.jsonc",
      exists: true,
      settings,
      issues: [],
      fromFile: [],
      notRead: [],
    };
  }
  const readSettings = vi.fn(() => current);
  /** Registers `providers` and enables each by its id, then applies `edit`. */
  function useProviders(
    providers: Array<{ id: string }>,
    edit: (settings: Settings) => void = () => {},
  ): void {
    mocks.getProviders.mockReturnValue(providers);
    useSettings((settings) => {
      settings.providers.off = [];
      edit(settings);
    });
  }
  /** Z.ai with its 5-hour window used up until 90 minutes from now. */
  const usedUpZai = () =>
    makeProvider("zai", [window("5h", 0, at(90 * MINUTE_MS))], (model) => model.includes("glm"));
  const WAIT_FOR_ZAI = 90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS;
  const sourceHost = {
    client: {
      config: {
        providers: async () => ({
          data: {
            providers: [{ id: "zai-coding-plan" }, { id: "gateway-a" }, { id: "gateway-b" }],
          },
        }),
      },
    },
    workspaceRoot: process.cwd(),
    settings: readSettings,
  };

  /** The plugin's retry host: a store over today's providers and settings, in memory. */
  async function createHost() {
    const { createQuotaStore } = await import("../src/core/store.js");
    const { loadServerSettings, loadProviderSource } =
      await import("../src/core/provider-source.js");
    const store = createQuotaStore({ source: () => loadProviderSource(sourceHost), file: null });
    return { store, loadSettings: () => loadServerSettings(sourceHost) };
  }

  async function resolve(event: QuotaRetryEvent) {
    const { resolveQuotaResetRetryDelayMs } = await import("../src/lib/quota-retry-wait.js");
    return resolveQuotaResetRetryDelayMs(await createHost(), event);
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("waits for the used-up window of the retried model's provider only", async () => {
    const zai = usedUpZai();
    const openai = makeProvider("openai", [window("Weekly", 0, at(10 * MINUTE_MS))], () => false);
    // waitForQuotaReset is on by default.
    useProviders([zai, openai]);

    await expect(resolve(limitEvent)).resolves.toBe(WAIT_FOR_ZAI);
    expect(zai.fetch).toHaveBeenCalledTimes(1);
    expect(openai.fetch).not.toHaveBeenCalled();
  });

  it("asks the provider for fresh quota on every limit error, whatever the interval", async () => {
    const zai = { ...usedUpZai(), cachePolicy: { kind: "account-neutral" } };
    useProviders([zai], (settings) => {
      settings.providers.checking.minIntervalMs = 60 * MINUTE_MS;
    });

    const { resolveQuotaResetRetryDelayMs } = await import("../src/lib/quota-retry-wait.js");
    const host = await createHost();
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(resolveQuotaResetRetryDelayMs(host, limitEvent)).resolves.toBe(WAIT_FOR_ZAI);
      expect(zai.fetch).toHaveBeenCalledTimes(attempt);
    }
  });

  it("ignores rows from an earlier read when the provider fails now", async () => {
    const zai = usedUpZai();
    useProviders([zai]);

    const { resolveQuotaResetRetryDelayMs } = await import("../src/lib/quota-retry-wait.js");
    const host = await createHost();
    await expect(resolveQuotaResetRetryDelayMs(host, limitEvent)).resolves.toBe(WAIT_FOR_ZAI);
    vi.setSystemTime(NOW_MS + MINUTE_MS);
    zai.fetch.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(resolveQuotaResetRetryDelayMs(host, limitEvent)).resolves.toBeUndefined();
  });

  it("counts only the custom definitions that serve the retried model", async () => {
    // Each custom definition is an account; its id is the login and in its row ids.
    const customWindow = (id: string, name: string, percent: number, resetMs: number) => ({
      name,
      login: id,
      rows: [
        percentRow(`custom.${id}.5h`, "5h", percent, {
          window: "five_hour",
          resetsAt: at(resetMs),
        }),
      ],
    });
    const custom = {
      ...makeProvider("quota-providers", [], () => true),
      fetch: vi.fn(async () =>
        answer(
          customWindow("gateway-a", "Gateway A", 40, 90 * MINUTE_MS),
          customWindow("gateway-b", "Gateway B", 0, 10 * MINUTE_MS),
        ),
      ),
    };
    const definition = (id: string) => ({
      id,
      providerId: id,
      label: id,
      mode: "remote-api" as const,
      format: "quota-v1" as const,
      url: `https://${id}.example/quota`,
    });
    mocks.getProviders.mockReturnValue([custom]);
    useSettings((settings) => {
      settings.providers.off = [];
      settings.providers.checking.minIntervalMs = 60 * MINUTE_MS;
      settings.providers.custom = [definition("gateway-a"), definition("gateway-b")];
    });

    const onA = { ...limitEvent, model: { id: "model-a", providerID: "gateway-a" } };
    await expect(resolve(onA)).resolves.toBeUndefined();
    const onB = { ...limitEvent, model: { id: "model-b", providerID: "gateway-b" } };
    await expect(resolve(onB)).resolves.toBe(10 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("ignores a provider where one of the logins failed: its kept rows are old", async () => {
    const zai = usedUpZai();
    zai.fetch.mockResolvedValue(
      answer(
        { name: "Z.ai", rows: [window("5h", 0, at(90 * MINUTE_MS))] },
        { name: "[Z.ai Work]", errors: ["Token expired"] },
      ),
    );
    useProviders([zai]);

    await expect(resolve(limitEvent)).resolves.toBeUndefined();
  });

  it("keeps OpenCode's decision when the setting is off", async () => {
    const zai = usedUpZai();
    useProviders([zai], (settings) => {
      settings.providers.checking.waitForQuotaReset = false;
    });

    await expect(resolve(limitEvent)).resolves.toBeUndefined();
    expect(zai.fetch).not.toHaveBeenCalled();
  });

  it("keeps OpenCode's decision for errors that are not limits, without reading settings", async () => {
    useSettings(() => {});

    await expect(
      resolve({ ...limitEvent, error: { type: "provider.transport" } }),
    ).resolves.toBeUndefined();
    expect(readSettings).not.toHaveBeenCalled();
  });

  it("keeps OpenCode's decision when the provider still has quota left", async () => {
    useProviders([
      makeProvider("zai", [window("5h", 12, at(90 * MINUTE_MS))], (model) => model.includes("glm")),
    ]);

    await expect(resolve(limitEvent)).resolves.toBeUndefined();
  });
});
