import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaSurfaceHost } from "../src/lib/quota-surface-data.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-lib-quota-surface-data-tests";
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const ANNOUNCEMENT_HOME_MESSAGE =
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
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  getMaintainerAnnouncementsSummary: vi.fn(),
  formatMaintainerAnnouncementHomeCountLine: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);
vi.mock("../src/lib/maintainer-announcements.js", () => ({
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [TEST_ANNOUNCEMENT],
  formatMaintainerAnnouncementHomeCountLine: mocks.formatMaintainerAnnouncementHomeCountLine,
  getMaintainerAnnouncementsSummary: mocks.getMaintainerAnnouncementsSummary,
  getMaintainerAnnouncementTargetProviderIds: () => ["copilot"],
}));

function createHost(): QuotaSurfaceHost {
  return {
    client: {
      config: {
        get: async () => ({ data: {} }),
        providers: async () => ({ data: { providers: [{ id: "copilot" }] } }),
      },
    },
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    resolveSessionMeta: async () => ({}),
  };
}

function makeCopilotProvider() {
  return {
    id: "copilot",
    isAvailable: vi.fn().mockResolvedValue(true),
    fetch: vi.fn().mockResolvedValue({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 81 }],
      errors: [],
    }),
  };
}

describe("quota surface data", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    mocks.getMaintainerAnnouncementsSummary.mockReturnValue({
      source: "bundled_only",
      network: false,
      bundledCount: 1,
      activeCount: 1,
      futureCount: 0,
      expiredCount: 0,
      activeAnnouncements: [{ announcement: TEST_ANNOUNCEMENT, active: true, reasons: [] }],
      evaluations: [],
    });
    mocks.formatMaintainerAnnouncementHomeCountLine.mockImplementation((activeCount: number) =>
      activeCount === 1 ? ANNOUNCEMENT_HOME_MESSAGE : "",
    );
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("projects all sidebar windows before formatting when it overrides singleWindow", async () => {
    const runtimeModule = await import("../src/lib/quota-runtime-context.js");
    const renderDataModule = await import("../src/lib/quota-render-data.js");
    const sidebarModule = await import("../src/lib/tui-sidebar-format.js");
    vi.spyOn(runtimeModule, "resolveQuotaRuntimeContext").mockResolvedValue({
      client: {},
      config: {
        enabled: true,
        enableToast: true,
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        resetTimeDecimals: undefined,
        toastDurationMs: 5000,
        tuiSidebarPanel: { enabled: true, formatStyle: "allWindows" },
      },
      configMeta: {},
      providers: [],
      resolveRuntimeProviderIds: vi.fn(),
      roots: { workspaceRoot: "/project", configRoot: "/project" },
      session: { sessionID: "session-1" },
    } as never);
    const collect = vi.spyOn(renderDataModule, "collectQuotaRenderData").mockImplementation(
      async ({ formatStyle }) =>
        ({
          active: [{ id: "copilot" }],
          data: {
            entries:
              formatStyle === "allWindows"
                ? [
                    { name: "Copilot 5h", percentRemaining: 50 },
                    { name: "Copilot Weekly", percentRemaining: 80 },
                  ]
                : [{ name: "Copilot 5h", percentRemaining: 50 }],
            errors: [],
          },
        }) as never,
    );
    const buildSidebarQuotaPanelLines = vi
      .spyOn(sidebarModule, "buildSidebarQuotaPanelLines")
      .mockImplementation(({ data }) => data.entries.map((entry) => entry.name));
    const { getQuotaMessage } = await import("../src/lib/quota-surface-data.js");

    const quota = await getQuotaMessage(createHost(), "session-1", "sidebar");

    expect(quota).toEqual({
      message: "Copilot 5h\nCopilot Weekly",
      duration: 5000,
      activeProviderCount: 1,
      resetNotification: undefined,
    });
    expect(buildSidebarQuotaPanelLines).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entries: [
            expect.objectContaining({ name: "Copilot 5h" }),
            expect.objectContaining({ name: "Copilot Weekly" }),
          ],
        }),
        config: expect.objectContaining({ formatStyle: "allWindows" }),
      }),
    );
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ formatStyle: "allWindows" }));
  });

  it("spaces reset countdowns the same way on the toast, sidebar and footers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const copilot = makeCopilotProvider();
      copilot.fetch.mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: TEST_ACCOUNTING,
            name: "Copilot",
            percentRemaining: 81,
            resetTimeIso: "2026-01-04T00:35:00.000Z",
          },
        ],
        errors: [],
      });
      mocks.getProviders.mockReturnValue([copilot]);
      const { getQuotaFooter, getQuotaMessage } = await import("../src/lib/quota-surface-data.js");
      const configBase = {
        enabled: true,
        enabledProviders: ["copilot"],
        minIntervalMs: 0,
        maintainerAnnouncements: { enabled: false, home: false },
        tuiSidebarPanel: { enabled: true },
        tuiPromptBar: { enabled: true },
        tuiCompactStatus: { enabled: true, homeBottom: true, sessionPrompt: true, maxWidth: 96 },
      } as const;

      mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig(configBase));
      const spacedToast = await getQuotaMessage(createHost(), "session-1", "idle");
      const spacedSidebar = await getQuotaMessage(createHost(), "session-1", "sidebar");
      const spacedHome = await getQuotaFooter(createHost(), undefined, "home");
      const spacedPrompt = await getQuotaFooter(createHost(), "session-1", "prompt");
      for (const text of [
        spacedToast?.message,
        spacedSidebar?.message,
        spacedHome.join("\n"),
        spacedPrompt.join("\n"),
      ]) {
        expect(text).toContain("3d 0h 35m");
      }

      mocks.loadConfig.mockResolvedValue(
        makeQuotaToastTestConfig({ ...configBase, resetTimeSpaced: false }),
      );
      const denseToast = await getQuotaMessage(createHost(), "session-1", "idle");
      const denseSidebar = await getQuotaMessage(createHost(), "session-1", "sidebar");
      const denseHome = await getQuotaFooter(createHost(), undefined, "home");
      for (const text of [denseToast?.message, denseSidebar?.message, denseHome.join("\n")]) {
        expect(text).toContain("3d0h35m");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("computes no prompt footer for the Home prompt, which has no session", async () => {
    const runtimeModule = await import("../src/lib/quota-runtime-context.js");
    const resolve = vi.spyOn(runtimeModule, "resolveQuotaRuntimeContext");
    const { getQuotaFooter } = await import("../src/lib/quota-surface-data.js");

    await expect(getQuotaFooter(createHost(), undefined, "prompt")).resolves.toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("loads Home for every enabled provider without a session, even with onlyCurrentModel", async () => {
    const runtimeModule = await import("../src/lib/quota-runtime-context.js");
    const renderDataModule = await import("../src/lib/quota-render-data.js");
    vi.spyOn(runtimeModule, "resolveQuotaRuntimeContext").mockResolvedValue({
      client: {},
      config: {
        enabled: true,
        onlyCurrentModel: true,
        showSessionTokens: true,
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        maintainerAnnouncements: { enabled: false, home: false },
        tuiPromptBar: { enabled: false },
        tuiCompactStatus: { enabled: true, homeBottom: true, sessionPrompt: true, maxWidth: 80 },
      },
      configMeta: {},
      providers: [],
      resolveRuntimeProviderIds: vi.fn(),
      roots: { workspaceRoot: "/project", configRoot: "/project" },
      session: { sessionID: "ses_1", sessionMeta: { modelID: "m", providerID: "p" } },
    } as never);
    const collect = vi.spyOn(renderDataModule, "collectQuotaRenderData").mockResolvedValue({
      active: [],
      data: { entries: [{ name: "Copilot", percentRemaining: 50 }], errors: [] },
    } as never);
    const { getQuotaFooter } = await import("../src/lib/quota-surface-data.js");

    await getQuotaFooter(createHost(), undefined, "home");

    const params = collect.mock.calls[0][0];
    expect(params.config).toMatchObject({ onlyCurrentModel: false, showSessionTokens: false });
    expect(params.request).toEqual({ sessionID: undefined, sessionMeta: undefined });
    expect(params.workspaceRoot).toBe("/project");
  });

  it("computes the count-only Home announcement from the enabled providers", async () => {
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({
        enabled: true,
        enabledProviders: ["copilot"],
        minIntervalMs: 0,
        maintainerAnnouncements: { enabled: true, home: true },
      }),
    );
    mocks.getProviders.mockReturnValue([makeCopilotProvider()]);
    const { getQuotaFooter } = await import("../src/lib/quota-surface-data.js");

    await expect(getQuotaFooter(createHost(), undefined, "home")).resolves.toEqual([
      ANNOUNCEMENT_HOME_MESSAGE,
    ]);
    expect(mocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
  });

  describe("Home announcement frequency", () => {
    const MINUTE = 60_000;

    async function homeLinesAt(time: Date, homeFrequency?: "daily" | "always"): Promise<string[]> {
      vi.setSystemTime(time);
      mocks.loadConfig.mockResolvedValue(
        makeQuotaToastTestConfig({
          enabled: true,
          enabledProviders: ["copilot"],
          minIntervalMs: 0,
          maintainerAnnouncements: { enabled: true, home: true, homeFrequency },
        }),
      );
      mocks.getProviders.mockReturnValue([makeCopilotProvider()]);
      const { getQuotaFooter } = await import("../src/lib/quota-surface-data.js");
      return getQuotaFooter(createHost(), undefined, "home");
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the notice for 10 minutes on the first Home screen of each day by default", async () => {
      const morning = new Date(2026, 9, 10, 9, 0);
      await expect(homeLinesAt(morning)).resolves.toEqual([ANNOUNCEMENT_HOME_MESSAGE]);
      await expect(homeLinesAt(new Date(morning.getTime() + 9 * MINUTE), "daily")).resolves.toEqual(
        [ANNOUNCEMENT_HOME_MESSAGE],
      );
      await expect(
        homeLinesAt(new Date(morning.getTime() + 11 * MINUTE), "daily"),
      ).resolves.toEqual([]);
      await expect(homeLinesAt(new Date(2026, 9, 10, 23, 59), "daily")).resolves.toEqual([]);
      await expect(homeLinesAt(new Date(2026, 9, 11, 0, 1), "daily")).resolves.toEqual([
        ANNOUNCEMENT_HOME_MESSAGE,
      ]);
    });

    it("shows the notice on every Home screen with homeFrequency always", async () => {
      const morning = new Date(2026, 9, 10, 9, 0);
      await expect(homeLinesAt(morning, "always")).resolves.toEqual([ANNOUNCEMENT_HOME_MESSAGE]);
      await expect(
        homeLinesAt(new Date(morning.getTime() + 60 * MINUTE), "always"),
      ).resolves.toEqual([ANNOUNCEMENT_HOME_MESSAGE]);
    });

    it("does not use up the day's showing while no notice is active", async () => {
      mocks.getMaintainerAnnouncementsSummary.mockReturnValueOnce({
        source: "bundled_only",
        network: false,
        bundledCount: 1,
        activeCount: 0,
        futureCount: 1,
        expiredCount: 0,
        activeAnnouncements: [],
        evaluations: [],
      });
      const morning = new Date(2026, 9, 10, 9, 0);
      await expect(homeLinesAt(morning, "daily")).resolves.toEqual([]);
      await expect(
        homeLinesAt(new Date(morning.getTime() + 60 * MINUTE), "daily"),
      ).resolves.toEqual([ANNOUNCEMENT_HOME_MESSAGE]);
    });
  });

  it("skips the Home announcement when maintainerAnnouncements.home is off", async () => {
    const copilot = makeCopilotProvider();
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({
        enabled: true,
        enabledProviders: ["copilot"],
        minIntervalMs: 0,
        maintainerAnnouncements: { enabled: true, home: false },
        tuiCompactStatus: { enabled: true, homeBottom: true, sessionPrompt: false, maxWidth: 96 },
      }),
    );
    mocks.getProviders.mockReturnValue([copilot]);
    const { getQuotaFooter } = await import("../src/lib/quota-surface-data.js");

    const lines = await getQuotaFooter(createHost(), undefined, "home");

    expect(copilot.fetch).toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Copilot");
    expect(mocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    expect(mocks.formatMaintainerAnnouncementHomeCountLine).not.toHaveBeenCalled();
  });
});
