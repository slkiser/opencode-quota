import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAlibabaAuthModuleMock,
  createPluginTestClient as createClient,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginToolMockModule,
  createPluginTuiConfigInspection,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-announcements-tests";
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
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

const resetMocks = vi.hoisted(() => ({
  observeQuotaResetNotifications: vi.fn(),
  formatQuotaResetNotification: vi.fn(),
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
vi.mock("../src/lib/quota-reset-notifications.js", () => ({
  observeQuotaResetNotifications: resetMocks.observeQuotaResetNotifications,
  formatQuotaResetNotification: resetMocks.formatQuotaResetNotification,
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
  mocks.loadConfig.mockResolvedValue(
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
        entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 81 }],
        errors: [],
      }),
    },
  ]);
}

async function startCli() {
  const { default: plugin } = await import("../src/tui-v2.js");
  const listeners = new Map<string, (event: { data: Record<string, unknown> }) => void>();
  const toast = vi.fn();
  const context = {
    client: { session: { get: vi.fn().mockResolvedValue({ data: {} }) } },
    location: { directory: process.cwd() },
    data: {
      on: vi.fn((name: string, listener: (event: { data: Record<string, unknown> }) => void) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      }),
      location: { provider: { list: () => [{ id: "copilot" }] } },
    },
    keymap: { layer: vi.fn() },
    ui: {
      slot: vi.fn((claim: { append: string; render: () => unknown }) => {
        if (claim.append === "app") claim.render();
        return vi.fn();
      }),
      toast: { show: toast },
    },
  };
  const dispose = plugin.setup(context as never);
  return { listeners, toast, dispose };
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
    resetMocks.observeQuotaResetNotifications.mockResolvedValue([]);
    resetMocks.formatQuotaResetNotification.mockReturnValue(null);
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("builds the CLI /quota_announcements output from available providers", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");
    const announcementCommand = QUOTA_DIALOG_COMMANDS.find(
      (command) => command.id === "quota_announcements",
    );
    const client = createClient();
    expect(announcementCommand).toEqual(
      expect.objectContaining({ slashName: "quota_announcements" }),
    );

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
      const enabledProviders = Array.isArray(params?.enabledProviders)
        ? params.enabledProviders
        : [];
      return enabledProviders.includes("copilot")
        ? makeAnnouncementSummary()
        : makeAnnouncementSummary({ activeCount: 0, activeAnnouncements: [] });
    });

    const client = createClient();

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

    const client = createClient();

    await expect(buildAnnouncementsDialogOutput({ client })).resolves.toBe(
      "Maintainer announcements\n\nNo current announcements.",
    );
  });

  it("rejects /quota_announcements arguments", async () => {
    const client = createClient();

    await expect(
      buildAnnouncementsDialogOutput({
        client,
        arguments: "show copilot-credits",
      }),
    ).resolves.toBe(
      "Invalid arguments for /quota_announcements\n\nThis command does not accept arguments.\n\nUsage: /quota_announcements",
    );
  });

  it("shows one count-only announcement toast after the first visible V2 CLI quota toast", async () => {
    configureQuestionQuotaToast();
    const cli = await startCli();
    cli.listeners.get("session.tool.input.started")?.({
      data: { id: "call-1", name: "question", sessionID: "session-question" },
    });
    cli.listeners.get("session.tool.success")?.({
      data: { id: "call-1", sessionID: "session-question" },
    });
    await vi.waitFor(() => expect(cli.toast).toHaveBeenCalledTimes(2));
    expect(cli.toast.mock.calls[0]?.[0].message).toContain("Copilot");
    expect(cli.toast.mock.calls[1]?.[0].message).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(cli.toast.mock.calls[1]?.[0].message).not.toContain(TEST_ANNOUNCEMENT.message);
    expect(cli.toast.mock.calls[1]?.[0].message).not.toContain(TEST_ANNOUNCEMENT.id);
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
    cli.listeners.get("session.tool.input.started")?.({
      data: { id: "call-2", name: "question", sessionID: "session-question" },
    });
    cli.listeners.get("session.tool.success")?.({
      data: { id: "call-2", sessionID: "session-question" },
    });
    await vi.waitFor(() => expect(cli.toast).toHaveBeenCalledTimes(3));
    expect(
      cli.toast.mock.calls.filter(([notice]) => notice.message === ANNOUNCEMENT_TOAST_MESSAGE),
    ).toHaveLength(1);
    cli.dispose?.();
  });

  it("does not announce before or without a visible V2 CLI quota toast", async () => {
    mocks.loadConfig.mockResolvedValue(
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

    const cli = await startCli();
    cli.listeners.get("session.step.ended")?.({ data: { sessionID: "session-idle" } });
    cli.listeners.get("session.tool.input.started")?.({
      data: { id: "call-1", name: "question", sessionID: "session-question" },
    });
    cli.listeners.get("session.tool.failed")?.({
      data: { id: "call-1", sessionID: "session-question" },
    });
    await flushMaintainerFallbackWork();

    expect(announcementMocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    expect(cli.toast).not.toHaveBeenCalled();
    cli.dispose?.();
  });
});
