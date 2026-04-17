import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_HANDLED_SENTINEL } from "../src/lib/command-handled.js";
import {
  createPluginTestClient as createClient,
  makeQuotaToastTestConfig,
  resetPluginTestState,
  seedDefaultPricingMocks,
} from "./helpers/plugin-test-harness.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
  aggregateUsage: vi.fn(),
  resolveSessionTree: vi.fn(),
  formatQuotaStatsReport: vi.fn(),
  SessionNotFoundError: class SessionNotFoundError extends Error {
    sessionID: string;
    checkedPath: string;

    constructor(sessionID: string, checkedPath: string) {
      super(`Session not found: ${sessionID}`);
      this.name = "SessionNotFoundError";
      this.sessionID = sessionID;
      this.checkedPath = checkedPath;
    }
  },
}));

vi.mock("@opencode-ai/plugin", () => {
  const makeChain = () => {
    const chain: any = {};
    chain.optional = () => chain;
    chain.describe = () => chain;
    chain.int = () => chain;
    chain.min = () => chain;
    return chain;
  };

  const toolFn = ((definition: unknown) => definition) as any;
  toolFn.schema = {
    boolean: () => makeChain(),
    number: () => makeChain(),
  };

  return { tool: toolFn };
});

vi.mock("../src/lib/config.js", () => ({
  loadConfig: mocks.loadConfig,
  createLoadConfigMeta: () => ({ source: "test", paths: [], networkSettingSources: {} }),
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: mocks.getProviders,
}));

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  getPricingSnapshotMeta: mocks.getPricingSnapshotMeta,
  getPricingSnapshotSource: mocks.getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath: mocks.getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath: mocks.getRuntimePricingSnapshotPath,
  maybeRefreshPricingSnapshot: mocks.maybeRefreshPricingSnapshot,
  setPricingSnapshotAutoRefresh: mocks.setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection: mocks.setPricingSnapshotSelection,
}));

vi.mock("../src/lib/session-tokens.js", () => ({
  fetchSessionTokensForDisplay: mocks.fetchSessionTokensForDisplay,
}));

vi.mock("../src/lib/qwen-auth.js", () => ({
  isQwenCodeModelId: () => false,
  resolveQwenLocalPlanCached: vi.fn().mockResolvedValue({ state: "none" }),
}));

vi.mock("../src/lib/alibaba-auth.js", () => ({
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS: 5000,
  isAlibabaModelId: () => false,
  resolveAlibabaCodingPlanAuthCached: vi.fn().mockResolvedValue({ state: "none" }),
}));

vi.mock("../src/lib/quota-stats.js", () => ({
  aggregateUsage: mocks.aggregateUsage,
  resolveSessionTree: mocks.resolveSessionTree,
  SessionNotFoundError: mocks.SessionNotFoundError,
}));

vi.mock("../src/lib/quota-stats-format.js", () => ({
  formatQuotaStatsReport: mocks.formatQuotaStatsReport,
}));

describe("/tokens_session_all command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    resetPluginTestState();

    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({
        enabled: true,
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      }),
    );
    mocks.getProviders.mockReturnValue([]);
    mocks.fetchSessionTokensForDisplay.mockResolvedValue({
      sessionTokens: undefined,
      error: undefined,
    });
    seedDefaultPricingMocks(mocks);
    mocks.aggregateUsage.mockResolvedValue({ totals: {}, bySession: [] });
    mocks.formatQuotaStatsReport.mockReturnValue("formatted token report");
    mocks.resolveSessionTree.mockResolvedValue([
      { sessionID: "ses_parent", title: "Parent Session", depth: 0 },
      {
        sessionID: "ses_child",
        parentID: "ses_parent",
        title: "Child Session",
        depth: 1,
      },
    ]);
  });

  it("registers /tokens_session_all in plugin config", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client: createClient() } as any);
    const cfg: { command?: Record<string, { template: string; description: string }> } = {};

    await hooks.config?.(cfg as any);

    expect(cfg.command?.tokens_session_all).toEqual({
      template: "/tokens_session_all",
      description:
        "Token + deterministic cost summary for current session and all descendant child/subagent sessions.",
    });
  });

  it("aggregates the current session tree for /tokens_session_all", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "tokens_session_all",
        sessionID: "ses_parent",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(mocks.resolveSessionTree).toHaveBeenCalledWith("ses_parent");
    expect(mocks.aggregateUsage).toHaveBeenCalledWith({
      sinceMs: undefined,
      untilMs: undefined,
      sessionID: undefined,
      sessionIDs: ["ses_parent", "ses_child"],
    });
    expect(mocks.formatQuotaStatsReport).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Tokens used (Current Session Tree) (/tokens_session_all)",
        focusSessionID: "ses_parent",
        reportKind: "session_tree",
        sessionTree: {
          rootSessionID: "ses_parent",
          nodes: [
            { sessionID: "ses_parent", title: "Parent Session", depth: 0 },
            {
              sessionID: "ses_child",
              parentID: "ses_parent",
              title: "Child Session",
              depth: 1,
            },
          ],
        },
      }),
    );
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("formatted token report");
  });

  it("keeps /tokens_session scoped to the selected session only", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "tokens_session",
        sessionID: "ses_parent",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(mocks.resolveSessionTree).not.toHaveBeenCalled();
    expect(mocks.aggregateUsage).toHaveBeenCalledWith({
      sinceMs: undefined,
      untilMs: undefined,
      sessionID: "ses_parent",
      sessionIDs: undefined,
    });
    expect(mocks.formatQuotaStatsReport).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Tokens used (Current Session) (/tokens_session)",
        focusSessionID: "ses_parent",
        sessionOnly: true,
        reportKind: "session",
      }),
    );
  });

  it("injects a handled session lookup error for /tokens_session_all", async () => {
    mocks.resolveSessionTree.mockRejectedValueOnce(
      new mocks.SessionNotFoundError("ses_missing", "/tmp/opencode.db"),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "tokens_session_all",
        sessionID: "ses_missing",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Token report unavailable (/tokens_session_all)");
    expect(injected).toContain("session_lookup_error:");
    expect(injected).toContain("- session_id: ses_missing");
    expect(injected).toContain("- checked_path: /tmp/opencode.db");
  });

  it("injects a handled session lookup error for /tokens_session", async () => {
    mocks.aggregateUsage.mockRejectedValueOnce(
      new mocks.SessionNotFoundError("ses_parent", "/tmp/opencode.db"),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "tokens_session",
        sessionID: "ses_parent",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Token report unavailable (/tokens_session)");
    expect(injected).toContain("- session_id: ses_parent");
    expect(injected).toContain("- checked_path: /tmp/opencode.db");
  });
});
