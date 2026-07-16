import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildQuotaDialogCommandOutput,
  cleanupFns,
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
} = vi.hoisted(() => ({
  buildQuotaDialogCommandOutput: vi.fn(),
  cleanupFns: [] as Array<() => void>,
  createTuiQuotaClient: vi.fn(() => ({ config: {} })),
  getTuiRuntimeRootHints: vi.fn(() => ({
    worktreeRoot: "/tmp/worktree",
    activeDirectory: "/tmp/worktree",
    fallbackDirectory: "/tmp/worktree",
  })),
  getTuiSessionModelMeta: vi.fn(),
  loadTuiHomeBottomStatus: vi.fn(),
  loadTuiSessionQuotaSurfaces: vi.fn(),
  normalizeTuiSessionID: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim() && !value.includes("{") ? value.trim() : undefined,
  ),
  resolveTuiSurfaceRegistration: vi.fn(),
  writeTuiQuotaExportIfEnabled: vi.fn(),
}));

vi.mock("../src/lib/tui-runtime.js", () => ({
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
}));

vi.mock("../src/lib/quota-dialog-commands.js", () => ({
  QUOTA_DIALOG_COMMANDS: [
    {
      id: "quota",
      slashName: "quota",
      title: "OpenCode Quota",
      description: "Show deterministic quota output.",
      dialogSize: "xlarge",
      requiresSession: true,
    },
    {
      id: "quota_status",
      slashName: "quota_status",
      title: "OpenCode Quota Status",
      description: "Show quota status.",
      dialogSize: "xlarge",
      requiresSession: true,
      acceptsArguments: true,
    },
    {
      id: "quota_announcements",
      slashName: "quota_announcements",
      title: "OpenCode Quota Announcements",
      description: "Show quota announcements.",
      dialogSize: "xlarge",
    },
    {
      id: "tokens_between",
      slashName: "tokens_between",
      title: "OpenCode Quota Token Report",
      description: "Show token usage for a date range.",
      dialogSize: "xlarge",
      acceptsArguments: true,
    },
  ],
  buildQuotaDialogCommandOutput,
}));

vi.mock("solid-js", () => ({
  Show: (props: { when: unknown; children?: unknown; fallback?: unknown }) => {
    if (!props.when) return props.fallback ?? null;
    return typeof props.children === "function"
      ? (props.children as (value: unknown) => unknown)(props.when)
      : props.children;
  },
  createEffect: (fn: () => void) => fn(),
  createSignal: <T>(initial: T) => {
    let value = initial;
    return [
      () => value,
      (next: T | ((previous: T) => T)) => {
        value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
        return value;
      },
    ];
  },
  onCleanup: (fn: () => void) => {
    cleanupFns.push(fn);
  },
}));

vi.mock("@opentui/solid/jsx-runtime", () => ({
  Fragment: Symbol.for("Fragment"),
  jsx: (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? type(props) : { type, props },
  jsxs: (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? type(props) : { type, props },
}));

function createElement(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) {
  const nextProps = {
    ...(props ?? {}),
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  };
  return typeof type === "function" ? type(nextProps) : { type, props: nextProps };
}

function createApi() {
  const keymapLayers: Array<{ commands: Array<Record<string, unknown>> }> = [];
  const dialog = {
    setSize: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
  };
  const registered: Array<{
    order?: number;
    slots: Record<string, (ctx: unknown, props: any) => unknown>;
  }> = [];
  const unsubscribers: Array<() => void> = [];
  const kvStore = new Map<string, unknown>();
  const api = {
    route: {
      current: {
        name: "session",
        params: { sessionID: "session-route" },
      },
    },
    state: {
      provider: [],
      path: {
        worktree: "/tmp/worktree",
        directory: "/tmp/worktree",
      },
      session: {
        messages: vi.fn(() => []),
      },
    },
    theme: {
      current: {
        text: "text",
        textMuted: "muted",
      },
    },
    ui: {
      Prompt: vi.fn((props: Record<string, unknown>) => ({ type: "Prompt", props })),
      DialogPrompt: vi.fn((props: Record<string, unknown>) => ({ type: "DialogPrompt", props })),
      dialog,
      toast: vi.fn(),
    },
    event: {
      on: vi.fn(() => {
        const unsubscribe = vi.fn();
        unsubscribers.push(unsubscribe);
        return unsubscribe;
      }),
    },
    kv: {
      get: vi.fn((key: string, fallback?: unknown) =>
        kvStore.has(key) ? kvStore.get(key) : fallback,
      ),
      set: vi.fn((key: string, value: unknown) => {
        kvStore.set(key, value);
      }),
    },
    slots: {
      register: vi.fn(
        (plugin: {
          order?: number;
          slots: Record<string, (ctx: unknown, props: any) => unknown>;
        }) => {
          registered.push(plugin);
          return `slot-${registered.length}`;
        },
      ),
    },
    lifecycle: {
      onDispose: vi.fn(),
    },
    keymap: {
      registerLayer: vi.fn((layer: { commands: Array<Record<string, unknown>> }) => {
        keymapLayers.push(layer);
        return vi.fn();
      }),
    },
    client: {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: {
        prompt: vi.fn(),
        command: vi.fn(),
      },
    },
  };

  return { api, registered, unsubscribers, kvStore, keymapLayers, dialog };
}

async function loadTuiModule() {
  const mod = await import("../src/tui.tsx");
  return mod.default;
}

describe("tui plugin smoke", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).React = { createElement };
    cleanupFns.length = 0;
    buildQuotaDialogCommandOutput.mockReset();
    buildQuotaDialogCommandOutput.mockResolvedValue({
      state: "output",
      command: "quota",
      title: "OpenCode Quota",
      output: "Quota line 1\n\nQuota line 3",
      dialogSize: "xlarge",
    });
    createTuiQuotaClient.mockClear();
    getTuiRuntimeRootHints.mockClear();
    getTuiSessionModelMeta.mockReset();
    getTuiSessionModelMeta.mockResolvedValue({ modelID: "gpt-5", providerID: "openai" });
    loadTuiHomeBottomStatus.mockReset();
    loadTuiHomeBottomStatus.mockResolvedValue({
      status: "ready",
      compact: { status: "ready", text: "Home quota" },
    });
    loadTuiSessionQuotaSurfaces.mockReset();
    loadTuiSessionQuotaSurfaces.mockResolvedValue({
      sidebar: { status: "ready", lines: ["Sidebar quota"] },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockReset();
    writeTuiQuotaExportIfEnabled.mockReset();
    writeTuiQuotaExportIfEnabled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) cleanup();
    vi.clearAllTimers();
    delete (globalThis as any).React;
    vi.useRealTimers();
  });

  it("registers every deterministic command through the palette keymap", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.lifecycle.onDispose).toHaveBeenCalledOnce();
    expect(keymapLayers[0]?.commands.map((command) => command.slashName)).toEqual([
      "quota",
      "quota_status",
      "quota_announcements",
      "tokens_between",
    ]);
    for (const slashName of ["quota", "quota_status", "quota_announcements"]) {
      expect(
        keymapLayers[0]?.commands.filter((command) => command.slashName === slashName),
      ).toHaveLength(1);
    }
    expect(dialog.replace).not.toHaveBeenCalled();
  });

  it("injects native /quota inline with noReply and ignored text without a dialog or model call", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);
    const quota = keymapLayers[0]!.commands.find((command) => command.slashName === "quota")!;
    (quota.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota",
        client: { config: {} },
        sessionID: "session-route",
      }),
    );
    expect(api.client.session.prompt).toHaveBeenCalledOnce();
    expect(api.client.session.prompt).toHaveBeenCalledWith({
      sessionID: "session-route",
      noReply: true,
      parts: [
        {
          type: "text",
          text: "Quota line 1\n\nQuota line 3",
          ignored: true,
        },
      ],
    });
    expect(dialog.replace).not.toHaveBeenCalled();
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("keeps native /quota on the existing local dialog path when configured", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "dialog",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);
    const quota = keymapLayers[0]!.commands.find((command) => command.slashName === "quota")!;
    (quota.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog.replace).toHaveBeenCalledTimes(2);
    expect(dialog.setSize).toHaveBeenNthCalledWith(1, "xlarge");
    expect(dialog.setSize).toHaveBeenNthCalledWith(2, "xlarge");
    expect(api.client.session.prompt).not.toHaveBeenCalled();
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("shows the command error without falling back to quota output dialog when inline injection fails", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    api.client.session.prompt.mockRejectedValueOnce(new Error("prompt unavailable"));

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);
    const quota = keymapLayers[0]!.commands.find((command) => command.slashName === "quota")!;
    (quota.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.client.session.prompt).toHaveBeenCalledOnce();
    expect(dialog.replace).toHaveBeenCalledOnce();
    const errorDialog = dialog.replace.mock.calls[0]![0]() as any;
    expect(errorDialog.props.children).not.toContain("Quota line 1");
    expect(api.ui.toast).toHaveBeenCalledWith({
      variant: "error",
      message: "OpenCode Quota command failed",
    });
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("collects arguments with DialogPrompt before running an argument-capable command", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);
    const status = keymapLayers[0]!.commands.find(
      (command) => command.slashName === "quota_status",
    )!;
    (status.run as (input?: unknown) => void)();

    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    const prompt = dialog.replace.mock.calls[0]![0]() as any;
    expect(prompt).toEqual(
      expect.objectContaining({
        type: "DialogPrompt",
        props: expect.objectContaining({
          title: "OpenCode Quota Status Options",
        }),
      }),
    );

    prompt.props.onConfirm('  {"force":true}  ');
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota_status",
        arguments: '{"force":true}',
      }),
    );
    expect(api.client.session.prompt).not.toHaveBeenCalled();
    expect(api.client.session.command).not.toHaveBeenCalled();

    (status.run as (input?: unknown) => void)();
    const blankPrompt = dialog.replace.mock.calls.at(-1)![0]() as any;
    blankPrompt.props.onConfirm("   ");
    await Promise.resolve();
    await Promise.resolve();
    expect(buildQuotaDialogCommandOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "quota_status", arguments: undefined }),
    );

    const announcements = keymapLayers[0]!.commands.find(
      (command) => command.slashName === "quota_announcements",
    )!;
    (announcements.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(buildQuotaDialogCommandOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "quota_announcements" }),
    );
    expect(api.client.session.prompt).not.toHaveBeenCalled();
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("registers sidebar_content and compact slots independently", async () => {
    const plugin = await loadTuiModule();
    const sidebarOnly = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(sidebarOnly.api as any, undefined, {} as any);

    expect(sidebarOnly.registered).toHaveLength(1);
    expect(sidebarOnly.registered[0].order).toBe(150);
    expect(Object.keys(sidebarOnly.registered[0].slots)).toEqual(["sidebar_content"]);

    const compactOnly = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await plugin.tui(compactOnly.api as any, undefined, {} as any);

    expect(compactOnly.registered).toHaveLength(1);
    expect(compactOnly.registered[0].order).toBe(90);
    expect(Object.keys(compactOnly.registered[0].slots)).toEqual(["session_prompt", "home_bottom"]);

    const enabled = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await plugin.tui(enabled.api as any, undefined, {} as any);

    expect(enabled.registered).toHaveLength(2);
    expect(enabled.registered[0].order).toBe(150);
    expect(Object.keys(enabled.registered[0].slots)).toEqual(["sidebar_content"]);
    expect(enabled.registered[1].order).toBe(90);
    expect(Object.keys(enabled.registered[1].slots)).toEqual(["session_prompt", "home_bottom"]);
  });

  it("renders sidebar summary count from runtime state and persists detail toggles", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: {
        status: "ready",
        lines: ["Copilot 5h 82%"],
        linesExpanded: ["[Copilot]", "5h window 82%", "Weekly window 58%"],
        providerCount: 2,
      },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);

    const sidebarRegistration = registered.find((registration) => registration.order === 150);
    expect(sidebarRegistration).toBeDefined();

    sidebarRegistration!.slots.sidebar_content({}, { session_id: "session-1" });
    await Promise.resolve();

    const collapsed = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const collapsedHeader = collapsed.props.children[0];
    expect(collapsedHeader.props.children[0].props.children.props.children).toBe("▶ Quota");
    expect(collapsedHeader.props.children[1].props.children).toEqual([" (", 2, " providers)"]);
    expect(
      collapsed.props.children[1].props.children.map((line: any) => line.props.children),
    ).toEqual(["Copilot 5h 82%"]);

    collapsedHeader.props.children[0].props.onMouseDown();

    expect(api.kv.set).toHaveBeenCalledWith("quota-sidebar-collapsed", false);

    const expanded = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const expandedHeader = expanded.props.children[0];
    expect(expandedHeader.props.children[0].props.children.props.children).toBe("▼ Quota");
    expect(
      expanded.props.children[1].props.children.map((line: any) => line.props.children),
    ).toEqual(["[Copilot]", "5h window 82%", "Weekly window 58%"]);
  });

  it("keeps non-expandable empty sidebar panels visible while collapsed", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "ready", lines: [] },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);

    const sidebarRegistration = registered.find((registration) => registration.order === 150);
    expect(sidebarRegistration).toBeDefined();

    sidebarRegistration!.slots.sidebar_content({}, { session_id: "session-1" });
    await Promise.resolve();

    const rendered = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const header = rendered.props.children[0];
    expect(header.props.children[0].props.children.props.children).toBe("Quota");
    expect(rendered.props.children[1].props.children[0].props.children).toBe("Unavailable");
  });

  it("falls back to sidebar-only registration when surface resolution fails", async () => {
    const plugin = await loadTuiModule();
    const fallback = createApi();

    resolveTuiSurfaceRegistration.mockRejectedValueOnce(new Error("config unavailable"));

    await plugin.tui(fallback.api as any, undefined, {} as any);

    expect(fallback.registered).toHaveLength(1);
    expect(fallback.registered[0].order).toBe(150);
    expect(Object.keys(fallback.registered[0].slots)).toEqual(["sidebar_content"]);
  });

  it("does not register right-side compact slots", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await plugin.tui(api as any, undefined, {} as any);

    const slotNames = registered.flatMap((registration) => Object.keys(registration.slots));
    expect(slotNames).toContain("session_prompt");
    expect(slotNames).toContain("home_bottom");
    expect(slotNames).not.toContain("session_prompt_right");
    expect(slotNames).not.toContain("home_prompt_right");
  });

  it("renders home compact status centered with a blank line above it", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await plugin.tui(api as any, undefined, {} as any);

    const compactRegistration = registered.find((registration) => registration.order === 90);
    expect(compactRegistration).toBeDefined();

    const loading = compactRegistration!.slots.home_bottom({}, {}) as any;
    expect(loading).toMatchObject({
      type: "box",
      props: {
        children: [
          { type: "text", props: { children: " " } },
          null,
          {
            type: "box",
            props: {
              children: {
                type: "text",
                props: { children: "Quota loading…" },
              },
            },
          },
        ],
      },
    });

    await Promise.resolve();

    const rendered = compactRegistration!.slots.home_bottom({}, {}) as any;
    expect(rendered).toMatchObject({
      type: "box",
      props: {
        gap: 0,
        children: [
          {
            type: "text",
            props: { children: " " },
          },
          null,
          {
            type: "box",
            props: {
              flexDirection: "row",
              justifyContent: "center",
              children: {
                type: "text",
                props: {
                  fg: "muted",
                  wrapMode: "none",
                  children: "Home quota",
                },
              },
            },
          },
        ],
      },
    });
  });

  it("keeps announcement-only home host empty until a delayed announcement populates it", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    let resolveBottom!: (value: {
      status: "ready";
      announcementText: string;
      compact: { status: "disabled" };
    }) => void;
    loadTuiHomeBottomStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBottom = resolve;
      }),
    );
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await plugin.tui(api as any, undefined, {} as any);

    const homeBottom = registered[0].slots.home_bottom;
    const empty = homeBottom({}, {}) as any;
    expect(empty).toEqual({
      type: "box",
      props: { gap: 0, children: [null, null, null] },
    });

    resolveBottom({
      status: "ready",
      announcementText: "Notice: Maintainer announcement available. Run /quota_announcements.",
      compact: { status: "disabled" },
    });
    await Promise.resolve();

    const populated = homeBottom({}, {}) as any;
    expect(populated.type).toBe("box");
    expect(populated.props.children[0]).toMatchObject({
      type: "text",
      props: { children: " " },
    });
    expect(populated.props.children[1]).toMatchObject({
      type: "box",
      props: {
        children: {
          type: "text",
          props: {
            children: "Notice: Maintainer announcement available. Run /quota_announcements.",
          },
        },
      },
    });
    expect(populated.props.children[2]).toBeNull();
  });

  it("keeps export-only home host empty while still writing the export", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    loadTuiHomeBottomStatus.mockResolvedValueOnce({
      status: "disabled",
      compact: { status: "disabled" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: true,
    });

    await plugin.tui(api as any, undefined, {} as any);

    const rendered = registered[0].slots.home_bottom({}, {}) as any;
    expect(rendered).toEqual({
      type: "box",
      props: { gap: 0, children: [null, null, null] },
    });
    await Promise.resolve();
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledOnce();
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledWith({ api });
  });

  it("wraps api.ui.Prompt and forwards session prompt props and ref exactly", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    const onSubmit = vi.fn();
    const ref = vi.fn();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      quotaCommandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: false,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);

    const compactRegistration = registered.find((registration) => registration.order === 90);
    expect(compactRegistration).toBeDefined();

    compactRegistration!.slots.session_prompt(
      {},
      {
        session_id: "session-1",
        visible: false,
        disabled: true,
        on_submit: onSubmit,
        ref,
      },
    );

    expect(api.ui.Prompt).toHaveBeenCalledTimes(1);
    expect(api.ui.Prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      visible: false,
      disabled: true,
      onSubmit,
      ref,
    });
  });
});
