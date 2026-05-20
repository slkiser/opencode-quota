import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSidebarPanelLines,
  getSidebarPanelLinesExpanded,
  type SidebarPanelState,
} from "../src/lib/tui-panel-state.js";

describe("getSidebarPanelLinesExpanded", () => {
  it("returns linesExpanded when present and non-empty", () => {
    const panel: SidebarPanelState = {
      status: "ready",
      lines: ["line1"],
      linesExpanded: ["expanded1", "expanded2"],
    };
    expect(getSidebarPanelLinesExpanded(panel)).toEqual(["expanded1", "expanded2"]);
  });

  it("falls back to getSidebarPanelLines when linesExpanded is empty", () => {
    const panel: SidebarPanelState = {
      status: "ready",
      lines: ["line1"],
      linesExpanded: [],
    };
    expect(getSidebarPanelLinesExpanded(panel)).toEqual(["line1"]);
  });

  it("falls back to getSidebarPanelLines when linesExpanded is undefined", () => {
    const panel: SidebarPanelState = {
      status: "ready",
      lines: ["line1"],
    };
    expect(getSidebarPanelLinesExpanded(panel)).toEqual(["line1"]);
  });

  it("falls back to status placeholder when lines and linesExpanded are both empty", () => {
    const panel: SidebarPanelState = {
      status: "ready",
      lines: [],
    };
    expect(getSidebarPanelLinesExpanded(panel)).toEqual(["Unavailable"]);
  });
});

// --- Mocks (all hoisted) ---

const { mockProviders } = vi.hoisted(() => ({
  mockProviders: [] as any[],
}));

const {
  collectQuotaRenderDataMock,
  buildSidebarQuotaPanelLinesMock,
  actualCollectQuotaRenderDataHolder,
} = vi.hoisted(() => ({
  collectQuotaRenderDataMock: vi.fn(),
  buildSidebarQuotaPanelLinesMock: vi.fn(),
  actualCollectQuotaRenderDataHolder: { fn: null as any },
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/tmp/opencode-quota-collapse-test/data",
    configDir: "/tmp/opencode-quota-collapse-test/config",
    cacheDir: "/tmp/opencode-quota-collapse-test/cache",
    stateDir: "/tmp/opencode-quota-collapse-test/state",
  }),
  getOpencodeRuntimeDirCandidates: () => ({
    configDirs: [],
    dataDirs: [],
  }),
}));

vi.mock("../src/lib/quota-render-data.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-render-data.js")>(
    "../src/lib/quota-render-data.js",
  );
  actualCollectQuotaRenderDataHolder.fn = actual.collectQuotaRenderData;
  return { ...actual, collectQuotaRenderData: collectQuotaRenderDataMock };
});

vi.mock("../src/lib/tui-sidebar-format.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tui-sidebar-format.js")>(
    "../src/lib/tui-sidebar-format.js",
  );
  return { ...actual, buildSidebarQuotaPanelLines: buildSidebarQuotaPanelLinesMock };
});

import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { loadSidebarPanel } from "../src/lib/tui-runtime.js";
import { rm } from "fs/promises";

const COLLAPSE_TEST_ROOT = "/tmp/opencode-quota-collapse-test";

const TEST_CLIENT = {
  config: {
    providers: async () => ({ data: { providers: [] } }),
    get: async () => ({ data: {} }),
  },
};

describe("collectQuotaRenderData allWindowsData", () => {
  beforeEach(async () => {
    mockProviders.length = 0;
    vi.restoreAllMocks();
    __resetQuotaStateForTests();
    await rm(COLLAPSE_TEST_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    mockProviders.length = 0;
    vi.restoreAllMocks();
    __resetQuotaStateForTests();
    await rm(COLLAPSE_TEST_ROOT, { recursive: true, force: true });
  });

  it("returns allWindowsData when includeAllWindowsData is true and style is singleWindow", async () => {
    const provider = {
      id: "test-provider",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          { name: "Daily", label: "Daily:", percentRemaining: 50 },
          { name: "Weekly", label: "Weekly:", percentRemaining: 80 },
        ],
        errors: [],
      }),
    };

    const result = await actualCollectQuotaRenderDataHolder.fn({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["test-provider"],
        showSessionTokens: false,
      },
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
      providers: [provider],
      includeAllWindowsData: true,
    });

    expect(result.data).not.toBeNull();
    expect(result.allWindowsData).toBeDefined();
    expect(result.allWindowsData).not.toBeNull();
    expect(result.allWindowsData!.entries.length).toBe(2);
    expect(result.data!.entries.length).toBe(1);
  });

  it("does not return allWindowsData when includeAllWindowsData is not set", async () => {
    const provider = {
      id: "test-provider",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Daily", label: "Daily:", percentRemaining: 50 }],
        errors: [],
      }),
    };

    const result = await actualCollectQuotaRenderDataHolder.fn({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["test-provider"],
        showSessionTokens: false,
      },
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
      providers: [provider],
    });

    expect(result.data).not.toBeNull();
    expect(result.allWindowsData).toBeUndefined();
  });

  it("returns allWindowsData equal to data when style is already allWindows", async () => {
    const provider = {
      id: "test-provider",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          { name: "Daily", label: "Daily:", percentRemaining: 50 },
          { name: "Weekly", label: "Weekly:", percentRemaining: 80 },
        ],
        errors: [],
      }),
    };

    const result = await actualCollectQuotaRenderDataHolder.fn({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["test-provider"],
        showSessionTokens: false,
      },
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [provider],
      includeAllWindowsData: true,
    });

    expect(result.data).not.toBeNull();
    expect(result.allWindowsData).not.toBeNull();
    expect(result.allWindowsData!.entries).toEqual(result.data!.entries);
  });
});

describe("tui-runtime linesExpanded", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let worktreeDir: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-collapse-tui-"));
    worktreeDir = join(tempDir, "worktree");
    xdgConfigHome = join(tempDir, "xdg-config");

    mkdirSync(worktreeDir, { recursive: true });
    mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true });

    process.env.HOME = tempDir;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.XDG_DATA_HOME = join(tempDir, "xdg-data");
    process.env.XDG_CACHE_HOME = join(tempDir, "xdg-cache");
    process.env.XDG_STATE_HOME = join(tempDir, "xdg-state");
    delete process.env.OPENCODE_CONFIG_DIR;

    collectQuotaRenderDataMock.mockReset();
    buildSidebarQuotaPanelLinesMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("populates linesExpanded from allWindowsData", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "singleWindow",
          },
        },
      }),
      "utf8",
    );

    const data = {
      entries: [{ name: "Copilot 5h", percentRemaining: 18 }],
      errors: [],
      sessionTokens: undefined,
    };
    const allWindowsData = {
      entries: [
        { name: "Copilot 5h", percentRemaining: 18 },
        { name: "Copilot Daily", percentRemaining: 42 },
      ],
      errors: [],
      sessionTokens: undefined,
    };

    collectQuotaRenderDataMock.mockResolvedValue({
      data,
      allWindowsData,
      active: [{ id: "copilot" }, { id: "openai" }],
    });

    buildSidebarQuotaPanelLinesMock
      .mockReturnValueOnce(["Copilot 5h 82%"])
      .mockReturnValueOnce(["Copilot 5h 82%", "Copilot Daily 58%"]);

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: { worktree: worktreeDir, directory: worktreeDir },
          session: { messages: () => [] },
        },
        client: {},
      } as any,
      sessionID: "session-expanded",
    });

    expect(panel.status).toBe("ready");
    expect(panel.lines).toEqual(["Copilot 5h 82%"]);
    expect(panel.linesExpanded).toEqual(["Copilot 5h 82%", "Copilot Daily 58%"]);
    expect(panel.providerCount).toBe(2);

    expect(collectQuotaRenderDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeAllWindowsData: true }),
    );

    expect(buildSidebarQuotaPanelLinesMock).toHaveBeenCalledTimes(2);
    expect(buildSidebarQuotaPanelLinesMock).toHaveBeenNthCalledWith(1, {
      data,
      config: expect.objectContaining({ formatStyle: "singleWindow" }),
    });
    expect(buildSidebarQuotaPanelLinesMock).toHaveBeenNthCalledWith(2, {
      data: allWindowsData,
      config: expect.objectContaining({ formatStyle: "allWindows" }),
    });
  });

  it("omits linesExpanded when allWindowsData is null", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
          },
        },
      }),
      "utf8",
    );

    collectQuotaRenderDataMock.mockResolvedValue({ data: null, allWindowsData: null, active: [] });

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: { worktree: worktreeDir, directory: worktreeDir },
          session: { messages: () => [] },
        },
        client: {},
      } as any,
      sessionID: "session-no-expand",
    });

    expect(panel.status).toBe("ready");
    expect(panel.lines).toEqual([]);
    expect(panel.linesExpanded).toBeUndefined();
  });
});
