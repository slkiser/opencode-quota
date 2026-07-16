import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
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
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
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

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);

vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);

vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);

vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);

vi.mock("../src/lib/quota-stats.js", () => ({
  aggregateUsage: mocks.aggregateUsage,
  resolveSessionTree: mocks.resolveSessionTree,
  SessionNotFoundError: mocks.SessionNotFoundError,
}));

vi.mock("../src/lib/quota-stats-format.js", () => ({
  formatQuotaStatsReport: mocks.formatQuotaStatsReport,
}));

async function buildTokenDialogOutput(params: {
  command: "tokens_session" | "tokens_session_all";
  client: ReturnType<typeof createClient>;
  sessionID: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  const result = await buildQuotaDialogCommandOutput({
    command: params.command,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: params.sessionID,
  });
  expect(params.client.session.prompt).not.toHaveBeenCalled();
  expect(result.state).toBe("output");
  return result.state === "output" ? result.output : "";
}

describe("/tokens_session_all command", () => {
  beforeEach(() => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        enabled: true,
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      },
      resetModules: true,
      resetPluginState: true,
    });
    mocks.resolveQwenLocalPlanCached.mockResolvedValue({ state: "none" });
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValue({ state: "none" });
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

  it("registers /tokens_session_all in server plugin config", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");
    const tokensSessionAllCommand = QUOTA_DIALOG_COMMANDS.find(
      (command) => command.id === "tokens_session_all",
    );
    const hooks = await QuotaToastPlugin({ client: createClient() } as any);
    const cfg: { command?: Record<string, { template: string; description: string }> } = {};

    await hooks.config?.(cfg as any);

    expect(cfg.command?.tokens_session_all).toEqual({
      template: `/${tokensSessionAllCommand?.slashName}`,
      description: tokensSessionAllCommand?.description,
    });
  });

  it("aggregates the current session tree for /tokens_session_all", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    const output = await buildTokenDialogOutput({
      command: "tokens_session_all",
      client,
      sessionID: "ses_parent",
    });

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
        tableOptions: {
          compactHeaders: true,
          modelNameMaxWidth: 20,
        },
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
    expect(output).toContain("formatted token report");
  });

  it("keeps /tokens_session scoped to the selected session only", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    await buildTokenDialogOutput({
      command: "tokens_session",
      client,
      sessionID: "ses_parent",
    });

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
        tableOptions: {
          compactHeaders: true,
          modelNameMaxWidth: 20,
        },
      }),
    );
  });

  it("returns a dialog session lookup error for /tokens_session_all", async () => {
    mocks.resolveSessionTree.mockRejectedValueOnce(
      new mocks.SessionNotFoundError("ses_missing", "/tmp/opencode.db"),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    const injected = await buildTokenDialogOutput({
      command: "tokens_session_all",
      client,
      sessionID: "ses_missing",
    });
    expect(injected).toContain("Token report unavailable (/tokens_session_all)");
    expect(injected).toContain("session_lookup_error:");
    expect(injected).toContain("- session_id: ses_missing");
    expect(injected).toContain("- checked_path: /tmp/opencode.db");
  });

  it("returns a dialog session lookup error for /tokens_session", async () => {
    mocks.aggregateUsage.mockRejectedValueOnce(
      new mocks.SessionNotFoundError("ses_parent", "/tmp/opencode.db"),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    const injected = await buildTokenDialogOutput({
      command: "tokens_session",
      client,
      sessionID: "ses_parent",
    });
    expect(injected).toContain("Token report unavailable (/tokens_session)");
    expect(injected).toContain("- session_id: ses_parent");
    expect(injected).toContain("- checked_path: /tmp/opencode.db");
  });
});
