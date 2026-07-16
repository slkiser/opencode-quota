import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { collectQuotaRenderData, buildCompactQuotaStatusLine, buildSidebarQuotaPanelLines } =
  vi.hoisted(() => ({
    collectQuotaRenderData: vi.fn(),
    buildCompactQuotaStatusLine: vi.fn(),
    buildSidebarQuotaPanelLines: vi.fn(),
  }));

const { buildQuotaExport: mockBuildQuotaExport, writeQuotaExport: mockWriteQuotaExport } =
  vi.hoisted(() => ({
    buildQuotaExport: vi.fn(),
    writeQuotaExport: vi.fn(),
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

vi.mock("../src/lib/tui-compact-format.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tui-compact-format.js")>(
    "../src/lib/tui-compact-format.js",
  );
  return {
    ...actual,
    buildCompactQuotaStatusLine,
  };
});

vi.mock("../src/lib/quota-export.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-export.js")>(
    "../src/lib/quota-export.js",
  );
  return {
    ...actual,
    buildQuotaExport: mockBuildQuotaExport,
    writeQuotaExport: mockWriteQuotaExport,
  };
});

import {
  getTuiSessionModelMeta,
  loadSidebarPanel,
  normalizeTuiSessionID,
  loadTuiHomeBottomStatus,
  loadTuiHomeCompactStatus,
  loadTuiSessionQuotaSurfaces,
  resolveTuiCompactStatusRegistration,
  resolveTuiSurfaceRegistration,
  resolveWorkspaceDir,
  writeTuiQuotaExportIfEnabled,
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
    delete process.env.OPENCODE_CONFIG_DIR;

    collectQuotaRenderData.mockReset();
    buildCompactQuotaStatusLine.mockReset();
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

  it("still uses worktree root when process.cwd() differs from the active nested directory", async () => {
    process.chdir(tempDir);

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
      sessionID: "session-worktree-over-cwd",
    });

    expect(panel).toEqual({ status: "disabled", lines: [] });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("falls back to the active directory when no worktree root is available", async () => {
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

    writeFileSync(
      join(nestedDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
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
            worktree: undefined,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client: {},
      } as any,
      sessionID: "session-no-worktree",
    });

    expect(panel).toEqual({ status: "disabled", lines: [] });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
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
      active: [],
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
                model: { providerID: "copilot", id: "gpt-4.1" },
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
      active: [],
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

  it("shows sidebar loading instead of bare unavailable while onlyCurrentModel waits for session metadata", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            enabledProviders: ["copilot"],
            onlyCurrentModel: true,
          },
        },
      }),
      "utf8",
    );

    collectQuotaRenderData.mockResolvedValue({
      selection: {
        waitingForCurrentSelection: true,
      },
      active: [],
      data: null,
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
          session: {
            get: vi.fn().mockResolvedValue({ data: {} }),
          },
        },
      } as any,
      sessionID: "fresh-session",
    });

    expect(panel).toEqual({ status: "loading", lines: [] });
    expect(collectQuotaRenderData).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          sessionMeta: {},
        }),
      }),
    );
    expect(buildSidebarQuotaPanelLines).not.toHaveBeenCalled();
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

    collectQuotaRenderData.mockResolvedValue({ active: [], data });
    buildSidebarQuotaPanelLines.mockReturnValue(["[Copilot] (business)"]);

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

    expect(panel).toEqual({ status: "ready", lines: ["[Copilot] (business)"] });
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

    collectQuotaRenderData.mockResolvedValue({ active: [], data: weeklyData });
    buildSidebarQuotaPanelLines.mockReturnValue(["[Synthetic]", "Weekly window"]);

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

    expect(panel).toEqual({ status: "ready", lines: ["[Synthetic]", "Weekly window"] });
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
        active: [],
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

  it("normalizes placeholder TUI session route params as unavailable", () => {
    expect(normalizeTuiSessionID("%7BsessionID%7D")).toBeUndefined();
    expect(normalizeTuiSessionID("{sessionID}")).toBeUndefined();
    expect(normalizeTuiSessionID(" session-3 ")).toBe("session-3");
  });

  it("uses the TUI session.get parameter shape for session model metadata", async () => {
    const sessionGet = vi.fn().mockResolvedValue({
      data: { model: { providerID: "openai", id: "gpt-5" } },
    });
    const messages = vi.fn(() => [
      { role: "assistant", providerID: "cursor", modelID: "claude-3.7-sonnet" },
    ]);

    const meta = await getTuiSessionModelMeta(
      {
        client: {
          session: {
            get: sessionGet,
          },
        },
        state: {
          session: {
            messages,
          },
        },
      } as any,
      "session-3",
    );

    expect(sessionGet).toHaveBeenCalledWith({ sessionID: "session-3" });
    expect(messages).not.toHaveBeenCalled();
    expect(meta).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
  });

  it("falls back to the client lookup when the TUI state accessor throws", async () => {
    const stateGet = vi.fn(() => {
      throw new Error("state is not hydrated");
    });
    const sessionGet = vi.fn().mockResolvedValue({
      data: { model: { providerID: "qwen-code", id: "qwen3-coder-plus" } },
    });
    const messages = vi.fn(() => []);

    const meta = await getTuiSessionModelMeta(
      {
        client: { session: { get: sessionGet } },
        state: { session: { get: stateGet, messages } },
      } as any,
      "session-throwing-state",
    );

    expect(stateGet).toHaveBeenCalledWith("session-throwing-state");
    expect(sessionGet).toHaveBeenCalledWith({ sessionID: "session-throwing-state" });
    expect(messages).not.toHaveBeenCalled();
    expect(meta).toEqual({
      providerID: "qwen-code",
      modelID: "qwen3-coder-plus",
    });
  });

  it("does not read obsolete top-level session model fields", async () => {
    const sessionGet = vi.fn().mockResolvedValue({
      data: { providerID: "legacy-provider", modelID: "legacy-model" },
    });

    const meta = await getTuiSessionModelMeta(
      {
        client: { session: { get: sessionGet } },
        state: { session: { messages: () => [] } },
      } as any,
      "session-legacy",
    );

    expect(meta).toEqual({});
  });

  it("does not call session APIs for placeholder TUI session IDs", async () => {
    const stateGet = vi.fn(() => {
      throw new Error("should not be called");
    });
    const sessionGet = vi.fn().mockRejectedValue(new Error("should not be called"));
    const messages = vi.fn(() => []);

    const meta = await getTuiSessionModelMeta(
      {
        client: {
          session: {
            get: sessionGet,
          },
        },
        state: {
          session: {
            get: stateGet,
            messages,
          },
        },
      } as any,
      "%7BsessionID%7D",
    );

    expect(meta).toEqual({});
    expect(stateGet).not.toHaveBeenCalled();
    expect(sessionGet).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
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
              { role: "assistant", providerID: "openai", modelID: "gpt-4.1" },
              {
                role: "user",
                model: { providerID: "cursor", modelID: "claude-3.7-sonnet" },
              },
            ],
          },
        },
      } as any,
      "session-3",
    );

    expect(sessionGet).toHaveBeenCalledWith({ sessionID: "session-3" });
    expect(meta).toEqual({
      providerID: "cursor",
      modelID: "claude-3.7-sonnet",
    });
  });

  it("resolves compact registration and suppresses native provider quota clients", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: true,
              homeBottom: true,
              sessionPrompt: true,
              suppressWhenNativeProviderQuota: true,
            },
          },
        },
      }),
      "utf8",
    );

    const registration = await resolveTuiCompactStatusRegistration({
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
        experimental: {
          providerQuota: {},
        },
      },
    } as any);

    expect(registration).toEqual({
      enabled: false,
      homeBottom: false,
      sessionPrompt: false,
      hasNativeProviderQuota: true,
      suppressedByNativeProviderQuota: true,
    });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("resolves sidebar independently from compact native-provider suppression", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiSidebarPanel: {
              enabled: true,
            },
            tuiCompactStatus: {
              enabled: true,
              homeBottom: true,
              sessionPrompt: true,
              suppressWhenNativeProviderQuota: true,
            },
          },
        },
      }),
      "utf8",
    );

    const registration = await resolveTuiSurfaceRegistration({
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
        experimental: {
          providerQuota: {},
        },
      },
    } as any);

    expect(registration).toEqual({
      sidebar: {
        enabled: true,
      },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: true,
        suppressedByNativeProviderQuota: true,
      },
      announcements: {
        homeBottom: true,
      },
      homeBottom: true,
    });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("registers home bottom when export is enabled even without visible home content", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            export: { enabled: true },
            maintainerAnnouncements: { home: false },
            tuiCompactStatus: { enabled: false, homeBottom: false },
          },
        },
      }),
      "utf8",
    );

    const registration = await resolveTuiSurfaceRegistration({
      state: {
        provider: [],
        path: { worktree: worktreeDir, directory: nestedDir },
        session: { messages: () => [] },
      },
      client: {},
    } as any);

    expect(registration.homeBottom).toBe(true);
    expect(registration.compact.homeBottom).toBe(false);
    expect(registration.announcements.homeBottom).toBe(false);
  });

  it("loads compact session surface while returning disabled sidebar when sidebar config is off", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            percentDisplayMode: "used",
            tuiSidebarPanel: {
              enabled: false,
            },
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: true,
              maxWidth: 42,
            },
          },
        },
      }),
      "utf8",
    );

    const data = {
      entries: [
        {
          name: "Copilot 5h",
          percentRemaining: 18,
        },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({ active: [], data });
    buildSidebarQuotaPanelLines.mockReturnValue(["Sidebar quota"]);
    buildCompactQuotaStatusLine.mockReturnValue("Compact quota");

    const surfaces = await loadTuiSessionQuotaSurfaces({
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
      sessionID: "compact-sidebar-off",
    });

    expect(surfaces).toEqual({
      sidebar: { status: "disabled", lines: [] },
      compact: { status: "ready", text: "Compact quota" },
    });
    expect(collectQuotaRenderData).toHaveBeenCalledOnce();
    expect(buildSidebarQuotaPanelLines).not.toHaveBeenCalled();
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith({
      data,
      percentDisplayMode: "used",
      maxWidth: 42,
    });
  });

  it("skips session quota collection when sidebar and session compact are disabled", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiSidebarPanel: {
              enabled: false,
            },
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: false,
            },
          },
        },
      }),
      "utf8",
    );

    const surfaces = await loadTuiSessionQuotaSurfaces({
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
      sessionID: "all-session-surfaces-off",
    });

    expect(surfaces).toEqual({
      sidebar: { status: "disabled", lines: [] },
      compact: { status: "disabled" },
    });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
    expect(buildSidebarQuotaPanelLines).not.toHaveBeenCalled();
    expect(buildCompactQuotaStatusLine).not.toHaveBeenCalled();
  });

  it("loads sidebar and compact session surfaces from one collection", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            percentDisplayMode: "used",
            onlyCurrentModel: true,
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: true,
              maxWidth: 42,
            },
          },
        },
      }),
      "utf8",
    );

    const data = {
      entries: [
        {
          name: "Copilot 5h",
          percentRemaining: 18,
        },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({ active: [], data });
    buildSidebarQuotaPanelLines.mockReturnValue(["Sidebar quota"]);
    buildCompactQuotaStatusLine.mockReturnValue("Compact quota");

    const surfaces = await loadTuiSessionQuotaSurfaces({
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
          session: {
            get: vi.fn().mockResolvedValue({
              data: {
                model: { providerID: "copilot", id: "gpt-4.1" },
              },
            }),
          },
        },
      } as any,
      sessionID: "compact-session",
    });

    expect(surfaces).toEqual({
      sidebar: { status: "ready", lines: ["Sidebar quota"] },
      compact: { status: "ready", text: "Compact quota" },
    });
    expect(collectQuotaRenderData).toHaveBeenCalledOnce();
    expect(collectQuotaRenderData).toHaveBeenCalledWith(
      expect.objectContaining({
        surfaceExplicitProviderIssues: true,
        config: expect.objectContaining({
          onlyCurrentModel: true,
          percentDisplayMode: "used",
        }),
        request: expect.objectContaining({
          sessionID: "compact-session",
          sessionMeta: {
            providerID: "copilot",
            modelID: "gpt-4.1",
          },
        }),
      }),
    );
    expect(buildSidebarQuotaPanelLines).toHaveBeenCalledWith({
      data,
      config: expect.objectContaining({
        percentDisplayMode: "used",
      }),
    });
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith({
      data,
      percentDisplayMode: "used",
      maxWidth: 42,
    });
  });

  it("uses compact fallback text when session collection has no data", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: true,
            },
          },
        },
      }),
      "utf8",
    );

    collectQuotaRenderData.mockResolvedValue({ active: [], data: null });

    const surfaces = await loadTuiSessionQuotaSurfaces({
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
      sessionID: "compact-no-data",
    });

    expect(surfaces).toEqual({
      sidebar: { status: "ready", lines: [] },
      compact: { status: "ready", text: "Quota unavailable" },
    });
    expect(buildCompactQuotaStatusLine).not.toHaveBeenCalled();
  });

  it("marks both session surfaces loading while waiting for current selection", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            onlyCurrentModel: true,
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: true,
            },
          },
        },
      }),
      "utf8",
    );

    collectQuotaRenderData.mockResolvedValue({
      selection: {
        waitingForCurrentSelection: true,
      },
      active: [],
      data: null,
    });

    const surfaces = await loadTuiSessionQuotaSurfaces({
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
          session: {
            get: vi.fn().mockResolvedValue({ data: {} }),
          },
        },
      } as any,
      sessionID: "waiting-session",
    });

    expect(surfaces).toEqual({
      sidebar: { status: "loading", lines: [] },
      compact: { status: "loading" },
    });
    expect(buildSidebarQuotaPanelLines).not.toHaveBeenCalled();
    expect(buildCompactQuotaStatusLine).not.toHaveBeenCalled();
  });

  it("uses compact fallback text when home compact formatting returns empty", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: true,
              homeBottom: true,
            },
          },
        },
      }),
      "utf8",
    );

    const data = {
      entries: [],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({ active: [], data });
    buildCompactQuotaStatusLine.mockReturnValue("");

    const compact = await loadTuiHomeCompactStatus({
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
    });

    expect(compact).toEqual({ status: "ready", text: "Quota unavailable" });
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith({
      data,
      percentDisplayMode: "remaining",
      maxWidth: 96,
    });
  });

  it("loads announcement-only home bottom without fetching quota data", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: false,
              homeBottom: false,
            },
            maintainerAnnouncements: {
              enabled: true,
              home: true,
            },
          },
        },
      }),
      "utf8",
    );

    const bottom = await loadTuiHomeBottomStatus({
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
      nowMs: Date.parse("2026-05-21T12:00:00.000Z"),
      announcements: [
        {
          id: "copilot-credits",
          message: "If you use Copilot, GitHub billing is moving to AI Credits.",
        },
      ],
    });

    expect(bottom).toEqual({
      status: "ready",
      announcementText: "Notice: Maintainer announcement available. Run /quota_announcements.",
      compact: { status: "disabled" },
    });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("loads provider-targeted announcement-only home bottom for detected providers", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: false,
              homeBottom: false,
            },
            maintainerAnnouncements: {
              enabled: true,
              home: true,
            },
          },
        },
      }),
      "utf8",
    );

    const bottom = await loadTuiHomeBottomStatus({
      api: {
        state: {
          provider: [{ id: "copilot" }],
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
      nowMs: Date.parse("2026-05-21T12:00:00.000Z"),
      announcements: [
        {
          id: "copilot-credits",
          message: "If you use Copilot, GitHub billing is moving to AI Credits.",
          providerIds: ["copilot"],
        },
      ],
    });

    expect(bottom).toEqual({
      status: "ready",
      announcementText: "Notice: Maintainer announcement available. Run /quota_announcements.",
      compact: { status: "disabled" },
    });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("does not render provider-targeted announcement-only home bottom without a detected provider", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: false,
              homeBottom: false,
            },
            maintainerAnnouncements: {
              enabled: true,
              home: true,
            },
          },
        },
      }),
      "utf8",
    );

    const bottom = await loadTuiHomeBottomStatus({
      api: {
        state: {
          provider: [{ id: "openai" }],
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
      nowMs: Date.parse("2026-05-21T12:00:00.000Z"),
      announcements: [
        {
          id: "copilot-credits",
          message: "If you use Copilot, GitHub billing is moving to AI Credits.",
          providerIds: ["copilot"],
        },
      ],
    });

    expect(bottom).toEqual({ status: "disabled", compact: { status: "disabled" } });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("keeps the July 14 bundled Copilot announcement hidden for a nonmatching provider", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: false,
              homeBottom: false,
            },
            maintainerAnnouncements: {
              enabled: true,
              home: true,
            },
          },
        },
      }),
      "utf8",
    );

    const bottom = await loadTuiHomeBottomStatus({
      api: {
        state: {
          provider: [{ id: "openai" }],
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
      nowMs: Date.parse("2026-07-14T12:00:00.000Z"),
    });

    expect(bottom).toEqual({ status: "disabled", compact: { status: "disabled" } });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("loads announcement and compact quota in one home bottom state", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: true,
              homeBottom: true,
            },
            maintainerAnnouncements: {
              enabled: true,
              home: true,
            },
          },
        },
      }),
      "utf8",
    );

    const data = {
      entries: [],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({ active: [], data });
    buildCompactQuotaStatusLine.mockReturnValue("Home compact quota");

    const bottom = await loadTuiHomeBottomStatus({
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
      nowMs: Date.parse("2026-05-21T12:00:00.000Z"),
      announcements: [
        {
          id: "copilot-credits",
          message: "If you use Copilot, GitHub billing is moving to AI Credits.",
        },
      ],
    });

    expect(bottom).toEqual({
      status: "ready",
      announcementText: "Notice: Maintainer announcement available. Run /quota_announcements.",
      compact: { status: "ready", text: "Home compact quota" },
    });
    expect(collectQuotaRenderData).toHaveBeenCalledOnce();
  });

  it("does not render inactive announcement-only home bottom", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            tuiCompactStatus: {
              enabled: false,
              homeBottom: false,
            },
            maintainerAnnouncements: {
              enabled: true,
              home: true,
            },
          },
        },
      }),
      "utf8",
    );

    const bottom = await loadTuiHomeBottomStatus({
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
      nowMs: Date.parse("2026-05-21T12:00:00.000Z"),
      announcements: [
        {
          id: "copilot-credits",
          message: "If you use Copilot, GitHub billing is moving to AI Credits.",
          startsAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    expect(bottom).toEqual({ status: "disabled", compact: { status: "disabled" } });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });

  it("loads home compact with an onlyCurrentModel false config copy", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            onlyCurrentModel: true,
            showSessionTokens: true,
            percentDisplayMode: "used",
            tuiCompactStatus: {
              enabled: true,
              homeBottom: true,
              maxWidth: 40,
            },
          },
        },
      }),
      "utf8",
    );

    const data = {
      entries: [
        {
          name: "Copilot 5h",
          percentRemaining: 25,
        },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockImplementation(async ({ config, request }) => {
      expect(config).toEqual(
        expect.objectContaining({
          onlyCurrentModel: false,
          showSessionTokens: false,
          percentDisplayMode: "used",
        }),
      );
      expect(request).toEqual({
        sessionID: undefined,
        sessionMeta: undefined,
      });
      return { data };
    });
    buildCompactQuotaStatusLine.mockReturnValue("Home compact quota");

    const compact = await loadTuiHomeCompactStatus({
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
    });

    expect(compact).toEqual({ status: "ready", text: "Home compact quota" });
    expect(collectQuotaRenderData).toHaveBeenCalledOnce();
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith({
      data,
      percentDisplayMode: "used",
      maxWidth: 40,
    });
    expect(buildSidebarQuotaPanelLines).not.toHaveBeenCalled();
  });

  it("uses tuiCompactStatus.formatStyle override for home compact status", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "singleWindow",
            tuiCompactStatus: {
              enabled: true,
              homeBottom: true,
              formatStyle: "allWindows",
            },
          },
        },
      }),
      "utf8",
    );

    const singleWindowData = {
      entries: [{ name: "Copilot", percentRemaining: 50 }],
      errors: [],
      sessionTokens: undefined,
    };
    const allWindowsData = {
      entries: [
        { name: "Copilot 5h", percentRemaining: 50 },
        { name: "Copilot Weekly", percentRemaining: 80 },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({
      active: [],
      data: singleWindowData,
      allWindowsData,
    });
    buildCompactQuotaStatusLine.mockReturnValue("50% 80%");

    const compact = await loadTuiHomeCompactStatus({
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
    });

    expect(compact).toEqual({ status: "ready", text: "50% 80%" });
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith(
      expect.objectContaining({ data: allWindowsData }),
    );
  });

  it("uses tuiCompactStatus.formatStyle override for home bottom compact status", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "singleWindow",
            tuiCompactStatus: {
              enabled: true,
              homeBottom: true,
              formatStyle: "allWindows",
            },
            maintainerAnnouncements: {
              enabled: false,
            },
          },
        },
      }),
      "utf8",
    );

    const singleWindowData = {
      entries: [{ name: "Copilot", percentRemaining: 50 }],
      errors: [],
      sessionTokens: undefined,
    };
    const allWindowsData = {
      entries: [
        { name: "Copilot 5h", percentRemaining: 50 },
        { name: "Copilot Weekly", percentRemaining: 80 },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({
      active: [],
      data: singleWindowData,
      allWindowsData,
    });
    buildCompactQuotaStatusLine.mockReturnValue("50% 80%");

    const bottom = await loadTuiHomeBottomStatus({
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
    });

    expect(bottom).toEqual({
      status: "ready",
      announcementText: undefined,
      compact: { status: "ready", text: "50% 80%" },
    });
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith(
      expect.objectContaining({ data: allWindowsData }),
    );
  });

  it("uses tuiSidebarPanel.formatStyle override instead of root formatStyle for sidebar", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "singleWindow",
            tuiSidebarPanel: {
              enabled: true,
              formatStyle: "allWindows",
            },
          },
        },
      }),
      "utf8",
    );

    const singleWindowData = {
      entries: [{ name: "Copilot", percentRemaining: 50 }],
      errors: [],
      sessionTokens: undefined,
    };
    const allWindowsData = {
      entries: [
        { name: "Copilot 5h", percentRemaining: 50 },
        { name: "Copilot Weekly", percentRemaining: 80 },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({
      active: [],
      data: singleWindowData,
      allWindowsData,
    });
    buildCompactQuotaStatusLine.mockReturnValue("Copilot 50%");
    buildSidebarQuotaPanelLines.mockReturnValueOnce(["[Copilot]", "5h line", "Weekly line"]);

    const surfaces = await loadTuiSessionQuotaSurfaces({
      api: {
        state: {
          provider: [],
          path: { worktree: worktreeDir, directory: nestedDir },
          session: { messages: () => [] },
        },
        client: {},
      } as any,
      sessionID: "session-sidebar-override",
    });

    // sidebar keeps compact text collapsed and all-windows lines expanded.
    expect(buildSidebarQuotaPanelLines).toHaveBeenCalledTimes(1);
    expect(buildSidebarQuotaPanelLines).toHaveBeenNthCalledWith(1, {
      data: allWindowsData,
      config: expect.objectContaining({ formatStyle: "allWindows" }),
    });
    expect(surfaces.sidebar).toEqual({
      status: "ready",
      lines: ["Copilot 50%"],
      linesExpanded: ["[Copilot]", "5h line", "Weekly line"],
    });
    // collect still used root formatStyle=singleWindow
    expect(collectQuotaRenderData).toHaveBeenCalledWith(
      expect.objectContaining({ formatStyle: "singleWindow" }),
    );
  });

  it("uses tuiCompactStatus.formatStyle override instead of root formatStyle for compact", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "singleWindow",
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: true,
              formatStyle: "allWindows",
            },
          },
        },
      }),
      "utf8",
    );

    const singleWindowData = {
      entries: [{ name: "Copilot", percentRemaining: 50 }],
      errors: [],
      sessionTokens: undefined,
    };
    const allWindowsData = {
      entries: [
        { name: "Copilot 5h", percentRemaining: 50 },
        { name: "Copilot Weekly", percentRemaining: 80 },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({
      active: [],
      data: singleWindowData,
      allWindowsData,
    });
    buildCompactQuotaStatusLine.mockReturnValue("50% 80%");

    const surfaces = await loadTuiSessionQuotaSurfaces({
      api: {
        state: {
          provider: [],
          path: { worktree: worktreeDir, directory: nestedDir },
          session: { messages: () => [] },
        },
        client: {},
      } as any,
      sessionID: "session-compact-override",
    });

    // compact uses allWindowsData (per compact.formatStyle=allWindows)
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith(
      expect.objectContaining({ data: allWindowsData }),
    );
    expect(surfaces.compact).toEqual({ status: "ready", text: "50% 80%" });
  });

  it("independent formatStyle overrides: sidebar allWindows, compact singleWindow", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "singleWindow",
            tuiSidebarPanel: {
              enabled: true,
              formatStyle: "allWindows",
            },
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: true,
              formatStyle: "singleWindow",
            },
          },
        },
      }),
      "utf8",
    );

    const singleWindowData = {
      entries: [{ name: "Copilot", percentRemaining: 50 }],
      errors: [],
      sessionTokens: undefined,
    };
    const allWindowsData = {
      entries: [
        { name: "Copilot 5h", percentRemaining: 50 },
        { name: "Copilot Weekly", percentRemaining: 80 },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({
      active: [],
      data: singleWindowData,
      allWindowsData,
    });
    buildSidebarQuotaPanelLines.mockReturnValue(["[Copilot]", "5h", "Weekly"]);
    buildCompactQuotaStatusLine.mockReturnValue("50%");

    const surfaces = await loadTuiSessionQuotaSurfaces({
      api: {
        state: {
          provider: [],
          path: { worktree: worktreeDir, directory: nestedDir },
          session: { messages: () => [] },
        },
        client: {},
      } as any,
      sessionID: "session-independent-overrides",
    });

    // sidebar → allWindowsData
    expect(buildSidebarQuotaPanelLines).toHaveBeenCalledWith({
      data: allWindowsData,
      config: expect.objectContaining({ formatStyle: "allWindows" }),
    });
    // compact → singleWindowData (formatStyle=singleWindow falls back to result.data)
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith(
      expect.objectContaining({ data: singleWindowData }),
    );
  });

  it("uses singleWindowData for compact when root=allWindows and compact.formatStyle=singleWindow", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "allWindows",
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: true,
              formatStyle: "singleWindow",
            },
          },
        },
      }),
      "utf8",
    );

    // root=allWindows → result.data is allWindows-projected
    const allWindowsData = {
      entries: [
        { name: "Copilot 5h", percentRemaining: 50 },
        { name: "Copilot Weekly", percentRemaining: 80 },
      ],
      errors: [],
      sessionTokens: undefined,
    };
    // singleWindowData pre-computed by collectQuotaRenderData when root=allWindows
    const singleWindowData = {
      entries: [{ name: "Copilot", percentRemaining: 50 }],
      errors: [],
      sessionTokens: undefined,
    };
    collectQuotaRenderData.mockResolvedValue({
      active: [],
      data: allWindowsData,
      allWindowsData,
      singleWindowData,
    });
    buildCompactQuotaStatusLine.mockReturnValue("50%");
    buildSidebarQuotaPanelLines.mockReturnValue([]);

    const surfaces = await loadTuiSessionQuotaSurfaces({
      api: {
        state: {
          provider: [],
          path: { worktree: worktreeDir, directory: nestedDir },
          session: { messages: () => [] },
        },
        client: {},
      } as any,
      sessionID: "session-compact-singlewindow-root-allwindows",
    });

    // compact must use singleWindowData, not allWindowsData
    expect(buildCompactQuotaStatusLine).toHaveBeenCalledWith(
      expect.objectContaining({ data: singleWindowData }),
    );
    expect(surfaces.compact).toEqual({ status: "ready", text: "50%" });
  });

  describe("writeTuiQuotaExportIfEnabled", () => {
    beforeEach(() => {
      mockBuildQuotaExport.mockReset();
      mockWriteQuotaExport.mockReset();
    });

    it("does not write when config.export.enabled is false", async () => {
      writeFileSync(
        join(worktreeDir, "opencode.json"),
        JSON.stringify({
          experimental: {
            quotaToast: {
              enabled: true,
              export: { enabled: false },
            },
          },
        }),
        "utf8",
      );

      await writeTuiQuotaExportIfEnabled({
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
      });

      expect(mockBuildQuotaExport).not.toHaveBeenCalled();
      expect(mockWriteQuotaExport).not.toHaveBeenCalled();
    });

    it("writes the export through writeQuotaExport at the resolved path when enabled", async () => {
      mockBuildQuotaExport.mockResolvedValue({
        version: 1,
        exportedAt: 0,
        fromCache: true,
        cacheAgeSeconds: 0,
        providers: {},
      });

      writeFileSync(
        join(worktreeDir, "opencode.json"),
        JSON.stringify({
          experimental: {
            quotaToast: {
              enabled: true,
              export: { enabled: true, path: "/tmp/test-tui-export.json" },
            },
          },
        }),
        "utf8",
      );

      await writeTuiQuotaExportIfEnabled({
        api: {
          state: {
            provider: [],
            path: { worktree: worktreeDir, directory: nestedDir },
            session: { messages: () => [] },
          },
          client: {},
        } as any,
      });

      expect(mockBuildQuotaExport).toHaveBeenCalledOnce();
      expect(mockWriteQuotaExport).toHaveBeenCalledOnce();
      expect(mockWriteQuotaExport.mock.calls[0][1]).toBe("/tmp/test-tui-export.json");
    });

    it("propagates writeQuotaExport errors to caller", async () => {
      mockBuildQuotaExport.mockResolvedValue({
        version: 1,
        exportedAt: 0,
        fromCache: true,
        cacheAgeSeconds: 0,
        providers: {},
      });
      mockWriteQuotaExport.mockRejectedValueOnce(new Error("write rejected"));

      writeFileSync(
        join(worktreeDir, "opencode.json"),
        JSON.stringify({
          experimental: {
            quotaToast: {
              enabled: true,
              export: { enabled: true, path: "/tmp/test-tui-export.json" },
            },
          },
        }),
        "utf8",
      );

      await expect(
        writeTuiQuotaExportIfEnabled({
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
        }),
      ).rejects.toThrow("write rejected");
    });
  });
});
