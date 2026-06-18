import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPluginTuiConfigInspection,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  getToastMessage,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-announcements-tests";
const ANNOUNCEMENT_TOAST_MESSAGE =
  "Notice: Maintainer announcement available. Run /quota_announcements.";

const TEST_ANNOUNCEMENT = vi.hoisted(() => ({
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
  providerIds: ["copilot"],
}));

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
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
}));

const announcementMocks = vi.hoisted(() => ({
  getMaintainerAnnouncementsSummary: vi.fn(),
}));

const tuiDiagnosticsMocks = vi.hoisted(() => ({
  inspectTuiConfig: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);
vi.mock("../src/lib/tui-config-diagnostics.js", () => ({
  inspectTuiConfig: tuiDiagnosticsMocks.inspectTuiConfig,
}));
vi.mock("../src/lib/maintainer-announcements.js", () => ({
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [TEST_ANNOUNCEMENT],
  formatMaintainerAnnouncementHomeCountLine: (activeCount: number) => {
    if (activeCount <= 0) return "";
    if (activeCount === 1) return ANNOUNCEMENT_TOAST_MESSAGE;
    return `Notice: ${activeCount} maintainer announcements available. Run /quota_announcements.`;
  },
  getMaintainerAnnouncementsSummary: announcementMocks.getMaintainerAnnouncementsSummary,
}));

function makeAnnouncementSummary(overrides: Record<string, unknown> = {}) {
  return {
    source: "bundled_only",
    network: false,
    bundledCount: 1,
    activeCount: 1,
    futureCount: 0,
    expiredCount: 0,
    activeAnnouncements: [
      {
        announcement: TEST_ANNOUNCEMENT,
        active: true,
        reasons: [],
      },
    ],
    evaluations: [],
    ...overrides,
  };
}

function configureQuestionQuotaToast(
  overrides: Parameters<typeof makeQuotaToastTestConfig>[0] = {},
): void {
  mocks.loadConfig.mockResolvedValueOnce(
    makeQuotaToastTestConfig({
      enabled: true,
      enableToast: true,
      enabledProviders: ["copilot"],
      showOnIdle: false,
      showOnQuestion: true,
      showOnCompact: false,
      minIntervalMs: 0,
      maintainerAnnouncements: {
        enabled: true,
        home: true,
      },
      ...overrides,
    }),
  );
  mocks.getProviders.mockReturnValue([
    {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Copilot", percentRemaining: 81 }],
        errors: [],
      }),
    },
  ]);
}

async function runSuccessfulQuestion(
  hooks: Record<string, any>,
  sessionID = "session-question",
): Promise<void> {
  await hooks["tool.execute.after"]?.(
    { tool: "question", sessionID, callID: `call-${sessionID}` },
    { title: "Question", output: "ok", metadata: { status: "success" } },
  );
}

async function buildAnnouncementsDialogOutput(params: {
  client: ReturnType<typeof createClient>;
  arguments?: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  const result = await buildQuotaDialogCommandOutput({
    command: "quota_announcements",
    arguments: params.arguments,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: "session-announcements",
  });
  expect(params.client.session.prompt).not.toHaveBeenCalled();
  expect(result.state).toBe("output");
  return result.state === "output" ? result.output : "";
}

async function flushMaintainerFallbackWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("maintainer announcement plugin integration", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        enabled: true,
        enableToast: true,
        showOnIdle: false,
        showOnQuestion: false,
        showOnCompact: false,
        maintainerAnnouncements: {
          enabled: true,
          home: true,
        },
      },
      resetPluginState: true,
    });
    announcementMocks.getMaintainerAnnouncementsSummary.mockReturnValue(makeAnnouncementSummary());
    tuiDiagnosticsMocks.inspectTuiConfig.mockResolvedValue(
      createPluginTuiConfigInspection(TEST_RUNTIME_ROOT),
    );
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("builds the no-arg /quota_announcements dialog output", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);
    const cfg: any = {};

    await hooks.config?.(cfg);
    expect(cfg.command?.quota_announcements).toBeUndefined();

    const output = await buildAnnouncementsDialogOutput({ client });

    expect(output).toBe(
      "Maintainer announcements\n\n- If you use Copilot, GitHub billing is moving to AI Credits.\n  https://github.blog/example",
    );
    expect(output).not.toContain("copilot-credits");
    expect(output).not.toContain("source:");
    expect(output).not.toContain("state");
    expect(provider.isAvailable).toHaveBeenCalledOnce();
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
  });

  it("renders none for provider-targeted announcements when the provider is unavailable", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);
    announcementMocks.getMaintainerAnnouncementsSummary.mockImplementation((params: any) => {
      const enabledProviders = Array.isArray(params?.enabledProviders) ? params.enabledProviders : [];
      return enabledProviders.includes("copilot")
        ? makeAnnouncementSummary()
        : makeAnnouncementSummary({ activeCount: 0, activeAnnouncements: [] });
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    await expect(buildAnnouncementsDialogOutput({ client })).resolves.toBe(
      "Maintainer announcements\n\nNo current announcements.",
    );
    expect(provider.isAvailable).toHaveBeenCalledOnce();
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: [] }),
    );
  });

  it("renders none when no active announcements are available", async () => {
    announcementMocks.getMaintainerAnnouncementsSummary.mockReturnValue(
      makeAnnouncementSummary({
        activeCount: 0,
        activeAnnouncements: [],
      }),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    await expect(buildAnnouncementsDialogOutput({ client })).resolves.toBe(
      "Maintainer announcements\n\nNo current announcements.",
    );
  });

  it("rejects /quota_announcements arguments", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    await expect(buildAnnouncementsDialogOutput({
      client,
      arguments: "show copilot-credits",
    })).resolves.toBe(
      "Invalid arguments for /quota_announcements\n\nThis command does not accept arguments.\n\nUsage: /quota_announcements",
    );
  });

  it("does not show fallback toasts when the quota TUI plugin is configured", async () => {
    configureQuestionQuotaToast();
    tuiDiagnosticsMocks.inspectTuiConfig.mockResolvedValueOnce(
      createPluginTuiConfigInspection(TEST_RUNTIME_ROOT, {
        configured: true,
        inferredSelectedPath: `${TEST_RUNTIME_ROOT}/config/tui.json`,
        presentPaths: [`${TEST_RUNTIME_ROOT}/config/tui.json`],
        candidatePaths: [`${TEST_RUNTIME_ROOT}/config/tui.json`],
        quotaPluginConfigured: true,
        quotaPluginConfigPaths: [`${TEST_RUNTIME_ROOT}/config/tui.json`],
      }),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks);

    await flushMaintainerFallbackWork();
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(getToastMessage(client)).toContain("Copilot");
    expect(getToastMessage(client)).not.toContain("/quota_announcements");
  });

  it("shows one count-only fallback toast after the first visible quota toast without TUI", async () => {
    configureQuestionQuotaToast();

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks);

    await flushMaintainerFallbackWork();
    expect(getToastMessage(client, 0)).toContain("Copilot");
    expect(getToastMessage(client, 1)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(getToastMessage(client, 1)).not.toContain(TEST_ANNOUNCEMENT.message);
    expect(getToastMessage(client, 1)).not.toContain(TEST_ANNOUNCEMENT.id);
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
  });

  it("does not show provider-targeted fallback for a different detected provider", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeQuotaToastTestConfig({
        enabled: true,
        enableToast: true,
        enabledProviders: "auto",
        showOnIdle: false,
        showOnQuestion: true,
        showOnCompact: false,
        minIntervalMs: 0,
        maintainerAnnouncements: {
          enabled: true,
          home: true,
        },
      }),
    );
    mocks.getProviders.mockReturnValue([
      {
        id: "openai",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ name: "OpenAI", percentRemaining: 75 }],
          errors: [],
        }),
      },
    ]);
    announcementMocks.getMaintainerAnnouncementsSummary.mockImplementation((params: any) => {
      const enabledProviders = Array.isArray(params?.enabledProviders) ? params.enabledProviders : [];
      return enabledProviders.includes("copilot")
        ? makeAnnouncementSummary()
        : makeAnnouncementSummary({ activeCount: 0, activeAnnouncements: [] });
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks);
    await flushMaintainerFallbackWork();

    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(getToastMessage(client, 0)).toContain("OpenAI");
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["openai"] }),
    );
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();
  });

  it("shows the fallback at most once per plugin process", async () => {
    configureQuestionQuotaToast();

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks, "session-question-1");
    await flushMaintainerFallbackWork();

    await runSuccessfulQuestion(hooks, "session-question-2");
    await flushMaintainerFallbackWork();

    expect(getToastMessage(client, 0)).toContain("Copilot");
    expect(getToastMessage(client, 1)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(getToastMessage(client, 2)).toContain("Copilot");
    expect(tuiDiagnosticsMocks.inspectTuiConfig).toHaveBeenCalledTimes(1);
  });

  it("does not attempt fallback before or without a visible quota toast", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeQuotaToastTestConfig({
        enabled: true,
        enableToast: true,
        showOnIdle: false,
        showOnQuestion: false,
        maintainerAnnouncements: {
          enabled: true,
          home: true,
        },
      }),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "session-idle" } },
    } as any);
    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-question", callID: "call-1" },
      { title: "Error", output: "failed", metadata: { status: "error" } },
    );

    expect(announcementMocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it("does not show fallback when announcements are disabled", async () => {
    configureQuestionQuotaToast({
      maintainerAnnouncements: {
        enabled: false,
        home: true,
      },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks);

    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(announcementMocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();
  });

  it("does not show fallback when automatic announcement surfaces are disabled", async () => {
    configureQuestionQuotaToast({
      maintainerAnnouncements: {
        enabled: true,
        home: false,
      },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks);

    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(announcementMocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();
  });

  it("does not retry fallback when no bundled notices can become active", async () => {
    configureQuestionQuotaToast();
    announcementMocks.getMaintainerAnnouncementsSummary.mockReturnValue(
      makeAnnouncementSummary({
        activeCount: 0,
        futureCount: 0,
        activeAnnouncements: [],
      }),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks, "session-question-1");
    await runSuccessfulQuestion(hooks, "session-question-2");

    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledTimes(1);
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();
  });

  it("does not attempt fallback when enableToast prevents a visible quota toast", async () => {
    configureQuestionQuotaToast({ enableToast: false });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks);

    expect(client.tui.showToast).not.toHaveBeenCalled();
    expect(announcementMocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();
  });

  it("keeps future-dated fallback pending until a later visible quota toast after activation", async () => {
    configureQuestionQuotaToast();
    announcementMocks.getMaintainerAnnouncementsSummary
      .mockReturnValueOnce(
        makeAnnouncementSummary({
          activeCount: 0,
          futureCount: 1,
          activeAnnouncements: [],
          evaluations: [
            {
              announcement: { ...TEST_ANNOUNCEMENT, startsAt: "2099-01-01T00:00:00Z" },
              active: false,
              reasons: ["not_started"],
            },
          ],
        }),
      )
      .mockReturnValue(makeAnnouncementSummary());

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks, "session-question-before");
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();

    await runSuccessfulQuestion(hooks, "session-question-after");

    await flushMaintainerFallbackWork();
    expect(getToastMessage(client, 0)).toContain("Copilot");
    expect(getToastMessage(client, 1)).toContain("Copilot");
    expect(getToastMessage(client, 2)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(tuiDiagnosticsMocks.inspectTuiConfig).toHaveBeenCalledTimes(1);
  });

  it("retries pending fallback on cached quota toasts using cached detected providers", async () => {
    configureQuestionQuotaToast({ minIntervalMs: 60_000 });
    announcementMocks.getMaintainerAnnouncementsSummary
      .mockReturnValueOnce(
        makeAnnouncementSummary({
          activeCount: 0,
          futureCount: 1,
          activeAnnouncements: [],
          evaluations: [
            {
              announcement: { ...TEST_ANNOUNCEMENT, startsAt: "2099-01-01T00:00:00Z" },
              active: false,
              reasons: ["not_started"],
            },
          ],
        }),
      )
      .mockReturnValue(makeAnnouncementSummary());

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks, "session-cached-fallback");
    await flushMaintainerFallbackWork();

    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(tuiDiagnosticsMocks.inspectTuiConfig).not.toHaveBeenCalled();

    await runSuccessfulQuestion(hooks, "session-cached-fallback");
    await flushMaintainerFallbackWork();

    expect(client.tui.showToast).toHaveBeenCalledTimes(3);
    expect(getToastMessage(client, 0)).toContain("Copilot");
    expect(getToastMessage(client, 1)).toContain("Copilot");
    expect(getToastMessage(client, 2)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledTimes(2);
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
    expect(tuiDiagnosticsMocks.inspectTuiConfig).toHaveBeenCalledTimes(1);
  });

  it("retries fallback after TUI detection fails", async () => {
    configureQuestionQuotaToast();
    tuiDiagnosticsMocks.inspectTuiConfig.mockRejectedValueOnce(new Error("diagnostics failed"));

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks, "session-question-diagnostics-fail");
    await flushMaintainerFallbackWork();

    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(getToastMessage(client, 0)).toContain("Copilot");
    expect(tuiDiagnosticsMocks.inspectTuiConfig).toHaveBeenCalledTimes(1);

    await runSuccessfulQuestion(hooks, "session-question-diagnostics-retry");
    await flushMaintainerFallbackWork();

    expect(client.tui.showToast).toHaveBeenCalledTimes(3);
    expect(getToastMessage(client, 1)).toContain("Copilot");
    expect(getToastMessage(client, 2)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(tuiDiagnosticsMocks.inspectTuiConfig).toHaveBeenCalledTimes(2);
  });

  it("retries fallback after fallback toast display fails", async () => {
    configureQuestionQuotaToast();

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    client.tui.showToast
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("fallback toast failed"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const hooks = await QuotaToastPlugin({ client } as any);

    await runSuccessfulQuestion(hooks, "session-question-display-fail");
    await flushMaintainerFallbackWork();

    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 0)).toContain("Copilot");
    expect(getToastMessage(client, 1)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);

    await runSuccessfulQuestion(hooks, "session-question-display-retry");
    await flushMaintainerFallbackWork();

    expect(client.tui.showToast).toHaveBeenCalledTimes(4);
    expect(getToastMessage(client, 2)).toContain("Copilot");
    expect(getToastMessage(client, 3)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(tuiDiagnosticsMocks.inspectTuiConfig).toHaveBeenCalledTimes(2);
  });
});
