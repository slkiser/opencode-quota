import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaProviderContext } from "../src/lib/entries.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  resolve: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("../src/lib/nine-router.js", () => ({
  fetchNineRouterAccounts: mocks.accounts,
  fetchNineRouterUsage: mocks.usage,
  resolveNineRouterConfig: mocks.resolve,
}));

import { nineRouterProvider } from "../src/providers/nine-router.js";

const ROOT = "https://router.example.test";
const KEY = "task-four-key-must-not-leak";
const ACCOUNT_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
] as const;

function configured() {
  return { success: true as const, root: ROOT };
}

function quota(percentRemaining: number) {
  return { success: true as const, windows: [{ kind: "weekly", percentRemaining }] };
}

function context(
  providers: readonly string[] = ["codex"],
  display: "perConnection" | "unified" = "perConnection",
): QuotaProviderContext {
  return {
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    resolveRuntimeProviderIds: async () => new Set(),
    config: {
      ...DEFAULT_CONFIG,
      nineRouter: { providers: [...providers], display },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("nineRouter provider", () => {
  it("is available only with valid management configuration and matches nineRouter models", async () => {
    mocks.resolve.mockReturnValueOnce({ success: false, error: "invalid" });
    await expect(nineRouterProvider.isAvailable(context())).resolves.toBe(false);
    mocks.resolve.mockReturnValueOnce(configured());
    await expect(nineRouterProvider.isAvailable(context())).resolves.toBe(true);
    expect(nineRouterProvider.matchesCurrentModel?.("9router/gpt-5")).toBe(true);
    expect(nineRouterProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("uses a domain-separated private cache identity", () => {
    vi.stubEnv("OPENCODE_NINEROUTER_API_KEY", KEY);
    mocks.resolve.mockReturnValue(configured());
    const identity = nineRouterProvider.cacheIdentity?.(context(["codex"]));
    const rootDigest = createHash("sha256").update(`9router:root:${ROOT}`).digest("hex");
    const keyDigest = createHash("sha256").update(`9router:key:${KEY}`).digest("hex");
    expect(identity).toBe(
      `root_sha256=${rootDigest};key_sha256=${keyDigest};providers_sha256=${createHash("sha256").update('9router:providers:["codex"]').digest("hex")};display_sha256=${createHash("sha256").update("9router:display:perconnection").digest("hex")}`,
    );
    expect(identity).not.toContain(ROOT);
    expect(identity).not.toContain(KEY);
  });

  it("maps separate accounts with safe labels and private source identities", async () => {
    mocks.resolve.mockReturnValue(configured());
    mocks.accounts.mockResolvedValue({
      success: true,
      accounts: [
        { id: ACCOUNT_IDS[0], provider: "codex", displayName: "Team Alpha" },
        { id: ACCOUNT_IDS[1], provider: "codex", email: "person@example.test" },
      ],
    });
    mocks.usage.mockResolvedValueOnce(quota(80)).mockResolvedValueOnce(quota(10));
    const result = await nineRouterProvider.fetch(context());
    expect(result).toMatchObject({
      attempted: true,
      errors: [],
      entries: [
        expect.objectContaining({ group: "codex / Team Alpha", percentRemaining: 80 }),
        expect.objectContaining({ group: "codex / per..example.test", percentRemaining: 10 }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_IDS[0]);
    expect(JSON.stringify(result)).not.toContain("person@example.test");
  });

  it("caps usage calls at four, preserves successful entries, and suppresses failures", async () => {
    mocks.resolve.mockReturnValue(configured());
    mocks.accounts.mockResolvedValue({
      success: true,
      accounts: ACCOUNT_IDS.map((id) => ({ id, provider: "codex" })),
    });
    let inFlight = 0;
    let maximumInFlight = 0;
    mocks.usage.mockImplementation(async (_config, id: string) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return id === ACCOUNT_IDS[2]
        ? { success: false as const, error: "private failure" }
        : quota(60);
    });
    const result = await nineRouterProvider.fetch(context());
    expect(maximumInFlight).toBeLessThanOrEqual(4);
    expect(result.entries).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("private failure");
  });

  it("omits failed and zero-window usage responses without fabricating quota", async () => {
    mocks.resolve.mockReturnValue(configured());
    mocks.accounts.mockResolvedValue({
      success: true,
      accounts: [{ id: ACCOUNT_IDS[0], provider: "codex", email: "private@example.test" }],
    });
    mocks.usage
      .mockResolvedValueOnce({ success: false, error: "private" })
      .mockResolvedValueOnce({ success: true, windows: [] });
    const failed = await nineRouterProvider.fetch(context());
    const empty = await nineRouterProvider.fetch(context());
    expect(failed).toEqual({ attempted: true, entries: [], errors: [] });
    expect(empty).toEqual({ attempted: true, entries: [], errors: [] });
  });

  it("rejects UUID and account-id labels", async () => {
    mocks.resolve.mockReturnValue(configured());
    mocks.accounts.mockResolvedValue({
      success: true,
      accounts: [
        { id: ACCOUNT_IDS[0], provider: "codex", displayName: ACCOUNT_IDS[0].toUpperCase() },
        { id: ACCOUNT_IDS[1], provider: "codex", name: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      ],
    });
    mocks.usage.mockResolvedValue(quota(42));
    const result = await nineRouterProvider.fetch(context());
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "codex / Account 1" }),
        expect.objectContaining({ group: "codex / Account 2" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_IDS[0]);
  });

  it("keeps duplicate labels scoped by provider and source", async () => {
    mocks.resolve.mockReturnValue(configured());
    mocks.accounts.mockResolvedValue({
      success: true,
      accounts: [
        { id: ACCOUNT_IDS[0], provider: "kiro", displayName: "Shared" },
        { id: ACCOUNT_IDS[1], provider: "kiro", displayName: "Shared" },
      ],
    });
    mocks.usage.mockResolvedValue(quota(80));
    const result = await nineRouterProvider.fetch(context(["kiro"]));
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "kiro / Shared" }),
        expect.objectContaining({ group: "kiro / Shared (2)" }),
      ]),
    );
    expect(result.entries[0]?.accounting.sourceId).not.toBe(result.entries[1]?.accounting.sourceId);
  });

  it("averages unified exact keys, preserves case distinctions, and uses earliest reset", async () => {
    mocks.resolve.mockReturnValue(configured());
    mocks.accounts.mockResolvedValue({
      success: true,
      accounts: ACCOUNT_IDS.slice(0, 2).map((id) => ({ id, provider: "kiro" })),
    });
    mocks.usage
      .mockResolvedValueOnce({
        success: true,
        windows: [
          { kind: "Weekly", percentRemaining: 80, resetTimeIso: "2026-01-02T00:00:00.000Z" },
          { kind: "weekly", percentRemaining: 100 },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        windows: [
          { kind: "Weekly", percentRemaining: 40, resetTimeIso: "2026-01-01T00:00:00.000Z" },
          { kind: "weekly", percentRemaining: 60 },
        ],
      });
    const result = await nineRouterProvider.fetch(context(["kiro"], "unified"));
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "nineRouter (kiro)",
          label: "Weekly:",
          percentRemaining: 60,
          resetTimeIso: "2026-01-01T00:00:00.000Z",
        }),
        expect.objectContaining({ label: "weekly:", percentRemaining: 80 }),
      ]),
    );
  });

  it("requests empty selections once, canonical explicit providers separately, and reserved all never", async () => {
    mocks.resolve.mockReturnValue(configured());
    mocks.accounts.mockResolvedValue({ success: true, accounts: [] });
    await nineRouterProvider.fetch(context([]));
    await nineRouterProvider.fetch(context([" KIRO ", "all", "codex", "kiro"]));
    await nineRouterProvider.fetch(context([" ALL ", "all"]));
    expect(mocks.accounts.mock.calls).toEqual([
      [configured()],
      [configured(), "codex"],
      [configured(), "kiro"],
    ]);
  });

  it("limits explicit account lists to four, isolates failures, and deduplicates IDs first-wins", async () => {
    mocks.resolve.mockReturnValue(configured());
    const started: string[] = [];
    mocks.accounts.mockImplementation(async (_config, provider?: string) => {
      if (!provider) return { success: true as const, accounts: [] };
      started.push(provider);
      return provider === "alpha"
        ? { success: false as const, error: "private" }
        : {
            success: true as const,
            accounts: [
              { id: ACCOUNT_IDS[0], provider, displayName: "Shared" },
              { id: ACCOUNT_IDS[0], provider: "ignored" },
            ],
          };
    });
    mocks.usage.mockResolvedValue(quota(70));
    const result = await nineRouterProvider.fetch(
      context(["gamma", "alpha", "epsilon", "beta", "delta"]),
    );
    expect(started.slice(0, 4)).toEqual(["alpha", "beta", "delta", "epsilon"]);
    expect(started).toHaveLength(5);
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(1);
  });

  it("returns unattempted when management configuration is invalid", async () => {
    mocks.resolve.mockReturnValue({ success: false, error: "invalid" });
    await expect(nineRouterProvider.fetch(context())).resolves.toEqual({
      attempted: false,
      entries: [],
      errors: [],
    });
  });
});
