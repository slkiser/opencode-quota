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

const { collectQuotaRenderDataMock, buildSidebarQuotaPanelLinesMock } = vi.hoisted(() => ({
  collectQuotaRenderDataMock: vi.fn(),
  buildSidebarQuotaPanelLinesMock: vi.fn(),
}));

vi.mock("../src/lib/quota-render-data.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-render-data.js")>(
    "../src/lib/quota-render-data.js",
  );
  return { ...actual, collectQuotaRenderData: collectQuotaRenderDataMock };
});

vi.mock("../src/lib/tui-sidebar-format.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tui-sidebar-format.js")>(
    "../src/lib/tui-sidebar-format.js",
  );
  return { ...actual, buildSidebarQuotaPanelLines: buildSidebarQuotaPanelLinesMock };
});

import { loadTuiSessionQuotaSurfaces } from "../src/lib/tui-runtime.js";

async function loadSidebarPanel(params: Parameters<typeof loadTuiSessionQuotaSurfaces>[0]) {
  return (await loadTuiSessionQuotaSurfaces(params)).sidebar;
}

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

  it("uses single-window lines plus expanded detail when sidebar format is singleWindow", async () => {
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
      .mockReturnValueOnce(["Single-window sidebar"])
      .mockReturnValueOnce(["[Copilot]", "5h window 18%", "Daily window 42%"]);

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
    expect(panel.lines).toEqual(["Single-window sidebar"]);
    expect(panel.linesExpanded).toEqual(["[Copilot]", "5h window 18%", "Daily window 42%"]);
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

  it("uses compact lines plus expanded detail when sidebar format is allWindows", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "allWindows",
          },
        },
      }),
      "utf8",
    );

    const data = {
      entries: [
        { name: "Copilot 5h", percentRemaining: 5 },
        { name: "OpenAI 5h", percentRemaining: 81 },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    const singleWindowData = {
      entries: [
        { name: "Copilot", percentRemaining: 5 },
        { name: "OpenAI", percentRemaining: 81 },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    const allWindowsData = data;

    collectQuotaRenderDataMock.mockResolvedValue({
      data,
      singleWindowData,
      allWindowsData,
      active: [{ id: "copilot" }, { id: "openai" }],
    });

    buildSidebarQuotaPanelLinesMock.mockReturnValueOnce([
      "[Copilot]",
      "Quota 95%",
      "[OpenAI]",
      "5h window 19%",
    ]);

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: { worktree: worktreeDir, directory: worktreeDir },
          session: { messages: () => [] },
        },
        client: {},
      } as any,
      sessionID: "session-all-windows-collapsible",
    });

    expect(panel.status).toBe("ready");
    expect(panel.lines).toEqual(["Copilot 5% | OpenAI 81%"]);
    expect(panel.linesExpanded).toEqual(["[Copilot]", "Quota 95%", "[OpenAI]", "5h window 19%"]);
    expect(panel.providerCount).toBe(2);

    expect(buildSidebarQuotaPanelLinesMock).toHaveBeenCalledTimes(1);
    expect(buildSidebarQuotaPanelLinesMock).toHaveBeenNthCalledWith(1, {
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
