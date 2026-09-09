import { afterEach, describe, expect, it, vi } from "vitest";

const { buildSidebarQuotaPanelLines, collectQuotaRenderData, resolveQuotaRuntimeContext } =
  vi.hoisted(() => ({
    buildSidebarQuotaPanelLines: vi.fn(),
    collectQuotaRenderData: vi.fn(),
    resolveQuotaRuntimeContext: vi.fn(),
  }));

vi.mock("../src/lib/quota-render-data.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-render-data.js")>(
    "../src/lib/quota-render-data.js",
  );
  return { ...actual, collectQuotaRenderData };
});

vi.mock("../src/lib/quota-runtime-context.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-runtime-context.js")>(
    "../src/lib/quota-runtime-context.js",
  );
  return { ...actual, resolveQuotaRuntimeContext };
});

vi.mock("../src/lib/tui-sidebar-format.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tui-sidebar-format.js")>(
    "../src/lib/tui-sidebar-format.js",
  );
  return { ...actual, buildSidebarQuotaPanelLines };
});

import plugin from "../src/tui-v2.tsx";

describe("V2 sidebar format style", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("projects all sidebar windows before formatting when it overrides singleWindow", async () => {
    vi.stubGlobal("React", {
      createElement: (type: unknown, props: Record<string, unknown>) =>
        typeof type === "function" ? type(props) : { type, props },
    });
    resolveQuotaRuntimeContext.mockResolvedValue({
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
      session: { sessionID: "session-1" },
    });
    collectQuotaRenderData.mockImplementation(async ({ formatStyle }) => ({
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
    }));
    buildSidebarQuotaPanelLines.mockImplementation(({ data }) =>
      data.entries.map((entry: { name: string }) => entry.name),
    );

    let sidebarRender: ((props: { sessionID: string }) => unknown) | undefined;
    plugin.setup({
      client: {},
      data: { on: vi.fn(() => vi.fn()) },
      keymap: { layer: vi.fn() },
      ui: {
        slot: vi.fn((claim) => {
          if (claim.append === "app") claim.render();
          if (claim.append === "sidebar.content") sidebarRender = claim.render;
          return vi.fn();
        }),
        toast: { show: vi.fn() },
        dialog: { alert: vi.fn(), prompt: vi.fn(), set: vi.fn() },
      },
    } as any);

    sidebarRender?.({ sessionID: "session-1" });

    await vi.waitFor(() => {
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
    });
    expect(collectQuotaRenderData).toHaveBeenCalledWith(
      expect.objectContaining({ formatStyle: "allWindows" }),
    );
  });
});
