import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { collectQuotaRenderData, buildSidebarQuotaPanelLines } = vi.hoisted(() => ({
  collectQuotaRenderData: vi.fn(),
  buildSidebarQuotaPanelLines: vi.fn(),
}));

vi.mock("../src/lib/quota-render-data.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-render-data.js")>(
    "../src/lib/quota-render-data.js",
  );
  return {
    ...actual,
    collectQuotaRenderData,
  };
});

vi.mock("../src/lib/tui-sidebar-format.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tui-sidebar-format.js")>(
    "../src/lib/tui-sidebar-format.js",
  );
  return {
    ...actual,
    buildSidebarQuotaPanelLines,
  };
});

import {
  getTuiSessionModelMeta,
  loadSidebarPanel,
  resolveWorkspaceDir,
} from "../src/lib/tui-runtime.js";

describe("tui runtime helpers", () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  let tempDir: string;
  let worktreeDir: string;
  let nestedDir: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-tui-"));
    worktreeDir = join(tempDir, "worktree");
    nestedDir = join(worktreeDir, "packages", "feature");
    xdgConfigHome = join(tempDir, "xdg-config");

    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true });

    process.env.HOME = tempDir;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.XDG_DATA_HOME = join(tempDir, "xdg-data");
    process.env.XDG_CACHE_HOME = join(tempDir, "xdg-cache");
    process.env.XDG_STATE_HOME = join(tempDir, "xdg-state");

    collectQuotaRenderData.mockReset();
    buildSidebarQuotaPanelLines.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prefers the worktree root over the active directory for config lookup", () => {
    expect(
      resolveWorkspaceDir({
        state: {
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
        },
      } as any),
    ).toBe(worktreeDir);
  });

  it("loads sidebar config from the worktree root when the active directory is nested", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
          },
        },
      }),
      "utf8",
    );

    writeFileSync(
      join(nestedDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
          },
        },
      }),
      "utf8",
    );

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client: {},
      } as any,
      sessionID: "session-1",
    });

    expect(panel).toEqual({ status: "disabled", lines: [] });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("honors sdk-backed quota config fallback when no config files are present", async () => {
    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client: {
          config: {
            get: vi.fn().mockResolvedValue({
              data: {
                experimental: {
                  quotaToast: {
                    enabled: false,
                  },
                },
              },
            }),
          },
        },
      } as any,
      sessionID: "session-sdk-fallback",
    });

    expect(panel).toEqual({ status: "disabled", lines: [] });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("preserves sdk-backed quota config fields when no config files are present", async () => {
    collectQuotaRenderData.mockResolvedValue({
      data: {
        entries: [],
        errors: [],
        sessionTokens: undefined,
      },
    });
    buildSidebarQuotaPanelLines.mockReturnValue(["Quota line"]);

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client: {
          config: {
            get: vi.fn().mockResolvedValue({
              data: {
                experimental: {
                  quotaToast: {
                    enabled: true,
                    formatStyle: "grouped",
                    percentDisplayMode: "used",
                    onlyCurrentModel: true,
                  },
                },
              },
            }),
          },
          session: {
            get: vi.fn().mockResolvedValue({
              data: {
                providerID: "copilot",
                modelID: "gpt-4.1",
              },
            }),
          },
        },
      } as any,
      sessionID: "session-sdk-fields",
    });

    expect(panel).toEqual({ status: "ready", lines: ["Quota line"] });
    expect(collectQuotaRenderData).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          formatStyle: "allWindows",
          percentDisplayMode: "used",
          onlyCurrentModel: true,
        }),
        formatStyle: "allWindows",
        request: expect.objectContaining({
          sessionMeta: {
            providerID: "copilot",
            modelID: "gpt-4.1",
          },
        }),
      }),
    );
    expect(buildSidebarQuotaPanelLines).toHaveBeenCalledWith({
      data: {
        entries: [],
        errors: [],
        sessionTokens: undefined,
      },
      config: expect.objectContaining({
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        onlyCurrentModel: true,
      }),
    });
  });

  it("keeps the sidebar enabled when enableToast is false", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            enableToast: false,
          },
        },
      }),
      "utf8",
    );

    collectQuotaRenderData.mockResolvedValue({
      data: {
        entries: [],
        errors: [],
        sessionTokens: undefined,
      },
    });
    buildSidebarQuotaPanelLines.mockReturnValue(["Quota line"]);

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client: {},
      } as any,
      sessionID: "session-2",
    });

    expect(panel).toEqual({ status: "ready", lines: ["Quota line"] });
    expect(collectQuotaRenderData).toHaveBeenCalledOnce();
    expect(buildSidebarQuotaPanelLines).toHaveBeenCalledOnce();
  });

  it("preserves canonical all-window formatStyle through sidebar runtime collection and formatting", async () => {
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
        {
          name: "Copilot",
          group: "Copilot (business)",
          label: "Usage:",
          kind: "value",
          value: "9 used | 2026-01 | org=acme-corp",
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
      ],
      errors: [],
      sessionTokens: undefined,
    };

    collectQuotaRenderData.mockResolvedValue({ data });
    buildSidebarQuotaPanelLines.mockReturnValue(["→ [Copilot] (business)"]);

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client: {},
      } as any,
      sessionID: "session-grouped",
    });

    expect(panel).toEqual({ status: "ready", lines: ["→ [Copilot] (business)"] });
    expect(collectQuotaRenderData).toHaveBeenCalledWith(
      expect.objectContaining({
        formatStyle: "allWindows",
      }),
    );
    expect(buildSidebarQuotaPanelLines).toHaveBeenCalledWith({
      data,
      config: expect.objectContaining({
        formatStyle: "allWindows",
      }),
    });
  });

  it("forwards weekly grouped row data unchanged from render-data to sidebar formatter", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "allWindows",
            percentDisplayMode: "used",
          },
        },
      }),
      "utf8",
    );

    const weeklyData = {
      entries: [
        {
          name: "Synthetic Weekly",
          group: "Synthetic",
          label: "Weekly:",
          percentRemaining: 8,
          right: "$22/$24",
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
      errors: [],
      sessionTokens: undefined,
    };

    collectQuotaRenderData.mockResolvedValue({ data: weeklyData });
    buildSidebarQuotaPanelLines.mockReturnValue(["→ [Synthetic]", "  Weekly: $22/$24"]);

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client: {},
      } as any,
      sessionID: "session-weekly-grouped",
    });

    expect(panel).toEqual({ status: "ready", lines: ["→ [Synthetic]", "  Weekly: $22/$24"] });
    expect(buildSidebarQuotaPanelLines).toHaveBeenCalledWith({
      data: weeklyData,
      config: expect.objectContaining({
        formatStyle: "allWindows",
        percentDisplayMode: "used",
      }),
    });
  });

  it("prefers api.client.config.providers over sidebar state providers", async () => {
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

    const runtimeProviders = vi.fn().mockResolvedValue({
      data: { providers: [{ id: "copilot" }, { id: "openai" }] },
    });

    collectQuotaRenderData.mockImplementation(async ({ client }) => {
      const response = await client.config.providers();
      expect(response).toEqual({
        data: { providers: [{ id: "copilot" }, { id: "openai" }] },
      });
      return {
        data: {
          entries: [],
          errors: [],
          sessionTokens: undefined,
        },
      };
    });
    buildSidebarQuotaPanelLines.mockReturnValue(["Quota line"]);

    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [{ id: "stale-state-provider" }],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client: {
          config: {
            providers: runtimeProviders,
          },
        },
      } as any,
      sessionID: "session-2b",
    });

    expect(panel).toEqual({ status: "ready", lines: ["Quota line"] });
    expect(runtimeProviders).toHaveBeenCalledOnce();
  });

  it("falls back to session messages when session.get fails under onlyCurrentModel", async () => {
    const sessionGet = vi.fn().mockRejectedValue(new Error("boom"));

    const meta = await getTuiSessionModelMeta(
      {
        client: {
          session: {
            get: sessionGet,
          },
        },
        state: {
          session: {
            messages: () => [
              { providerID: "openai", modelID: "gpt-4.1" },
              { model: { providerID: "cursor", modelID: "claude-3.7-sonnet" } },
            ],
          },
        },
      } as any,
      "session-3",
    );

    expect(sessionGet).toHaveBeenCalledWith({ path: { id: "session-3" } });
    expect(meta).toEqual({
      providerID: "cursor",
      modelID: "claude-3.7-sonnet",
    });
  });
});
