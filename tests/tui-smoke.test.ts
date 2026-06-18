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
  normalizeTuiSessionID: vi.fn((sessionID: unknown) => {
    if (typeof sessionID !== "string") return undefined;
    const trimmed = sessionID.trim();
    if (!trimmed) return undefined;
    let decoded = trimmed;
    try {
      decoded = decodeURIComponent(trimmed).trim();
    } catch {
      decoded = trimmed;
    }
    return decoded.includes("{") || decoded.includes("}") ? undefined : trimmed;
  }),
  resolveTuiSurfaceRegistration: vi.fn(),
}));

vi.mock("../src/lib/tui-runtime.js", () => ({
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
}));

vi.mock("../src/lib/quota-dialog-commands.js", () => ({
  QUOTA_DIALOG_COMMANDS: [
    {
      id: "quota",
      slashName: "quota",
      title: "OpenCode Quota",
      description: "Show quota output",
      dialogSize: "xlarge",
    },
    {
      id: "quota_status",
      slashName: "quota_status",
      title: "OpenCode Quota Status",
      description: "Show quota status",
      dialogSize: "xlarge",
      acceptsArguments: true,
    },
    {
      id: "tokens_between",
      slashName: "tokens_between",
      title: "OpenCode Quota Token Report",
      description: "Show token usage for a date range",
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
    client: {},
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
    getTuiSessionModelMeta.mockResolvedValue({ modelID: "openai/gpt-5", providerID: "openai" });
    loadTuiHomeBottomStatus.mockReset();
    loadTuiHomeBottomStatus.mockResolvedValue({
      status: "ready",
      compact: { status: "ready", text: "Home quota" },
    });
    loadTuiSessionQuotaSurfaces.mockReset();
    normalizeTuiSessionID.mockClear();
    loadTuiSessionQuotaSurfaces.mockResolvedValue({
      sidebar: { status: "ready", lines: ["Sidebar quota"] },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockReset();
  });

  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) cleanup();
    vi.clearAllTimers();
    delete (globalThis as any).React;
    vi.useRealTimers();
  });

  it("registers quota dialog slash commands through the palette keymap", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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

    expect(api.keymap.registerLayer).toHaveBeenCalledTimes(1);
    expect(api.lifecycle.onDispose).toHaveBeenCalledTimes(1);
    expect(keymapLayers).toHaveLength(1);
    expect(keymapLayers[0].commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "palette",
          name: "opencode-quota.quota",
          slashName: "quota",
          category: "OpenCode Quota",
        }),
        expect.objectContaining({
          namespace: "palette",
          name: "opencode-quota.quota_status",
          slashName: "quota_status",
          category: "OpenCode Quota",
        }),
      ]),
    );
  });

  it("renders deterministic command output in a dialog without session prompt writes", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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
    const quotaCommand = keymapLayers[0].commands.find((command) => command.slashName === "quota");
    expect(quotaCommand).toBeDefined();

    (quotaCommand!.run as (input?: unknown) => void)({ arguments: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota",
        client: { config: {} },
        roots: {
          worktreeRoot: "/tmp/worktree",
          activeDirectory: "/tmp/worktree",
          fallbackDirectory: "/tmp/worktree",
        },
        sessionID: "session-route",
      }),
    );
    expect(dialog.setSize).toHaveBeenNthCalledWith(1, "xlarge");
    expect(dialog.setSize).toHaveBeenNthCalledWith(2, "xlarge");
    expect(dialog.replace).toHaveBeenCalledTimes(2);
    expect(dialog.replace.mock.invocationCallOrder[0]).toBeLessThan(
      dialog.setSize.mock.invocationCallOrder[0],
    );
    expect(dialog.replace.mock.invocationCallOrder[1]).toBeLessThan(
      dialog.setSize.mock.invocationCallOrder[1],
    );
    const rendered = dialog.replace.mock.calls[1][0]() as any;
    expect(rendered.props).toMatchObject({
      gap: 1,
      width: "100%",
      flexGrow: 1,
      paddingLeft: 2,
      paddingRight: 2,
      paddingBottom: 1,
    });
    const scrollbox = rendered.props.children[1];
    expect(scrollbox.props).toMatchObject({
      width: "100%",
      flexGrow: 1,
      minHeight: 6,
      maxHeight: 28,
    });
    expect(scrollbox.props.children.props).toMatchObject({ gap: 0, width: "100%", minWidth: 0 });
    const lineNodes = scrollbox.props.children.props.children;
    expect(lineNodes.map((line: any) => line.props.children)).toEqual([
      "Quota line 1",
      " ",
      "Quota line 3",
    ]);
    expect(lineNodes[0].props).toMatchObject({ wrapMode: "word", width: "100%" });
    expect((api.client as any).session?.prompt).toBeUndefined();
  });

  it("treats placeholder route session params as no active session for dialog commands", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    api.route.current.params.sessionID = "%7BsessionID%7D";

    buildQuotaDialogCommandOutput.mockResolvedValueOnce({
      state: "output",
      command: "quota_status",
      title: "OpenCode Quota Status",
      output: "sessionModelLookup: no_session",
      dialogSize: "xlarge",
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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
    const statusCommand = keymapLayers[0].commands.find(
      (command) => command.slashName === "quota_status",
    );
    expect(statusCommand).toBeDefined();

    (statusCommand!.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota_status",
        sessionID: undefined,
      }),
    );
    expect(dialog.setSize).toHaveBeenNthCalledWith(1, "xlarge");
    expect(dialog.setSize).toHaveBeenNthCalledWith(2, "xlarge");
  });

  it("preserves session-token diagnostics between quota and quota_status dialog commands", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers } = createApi();
    const lastSessionTokenError = {
      sessionID: "session-route",
      error: "session token collection failed",
      checkedPath: "/tmp/worktree/.opencode",
    };

    buildQuotaDialogCommandOutput.mockImplementation(async (params) => {
      if (params.command === "quota") {
        params.setLastSessionTokenError(lastSessionTokenError);
        return {
          state: "output",
          command: "quota",
          title: "OpenCode Quota",
          output: "Quota output",
          dialogSize: "xlarge",
        };
      }

      return {
        state: "output",
        command: "quota_status",
        title: "OpenCode Quota Status",
        output: "Status output",
        dialogSize: "xlarge",
      };
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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
    const quotaCommand = keymapLayers[0].commands.find((command) => command.slashName === "quota");
    const statusCommand = keymapLayers[0].commands.find(
      (command) => command.slashName === "quota_status",
    );
    expect(quotaCommand).toBeDefined();
    expect(statusCommand).toBeDefined();

    (quotaCommand!.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();
    (statusCommand!.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: "quota_status",
        lastSessionTokenError,
      }),
    );
  });

  it("passes direct /tokens_between arguments to deterministic dialog output", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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
    const betweenCommand = keymapLayers[0].commands.find(
      (command) => command.slashName === "tokens_between",
    );
    expect(betweenCommand).toBeDefined();

    (betweenCommand!.run as (input?: unknown) => void)({
      arguments: "2026-01-01 2026-01-15",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(api.ui.DialogPrompt).not.toHaveBeenCalled();
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "tokens_between",
        arguments: "2026-01-01 2026-01-15",
      }),
    );
  });

  it("prompts for /tokens_between dates when slash arguments are missing", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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
    const betweenCommand = keymapLayers[0].commands.find(
      (command) => command.slashName === "tokens_between",
    );
    expect(betweenCommand).toBeDefined();

    (betweenCommand!.run as (input?: unknown) => void)();
    await Promise.resolve();

    expect(dialog.setSize).toHaveBeenNthCalledWith(1, "medium");
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    const prompt = dialog.replace.mock.calls[0][0]() as any;
    expect(prompt).toEqual(
      expect.objectContaining({
        type: "DialogPrompt",
        props: expect.objectContaining({
          title: "OpenCode Quota Token Range",
          placeholder: "YYYY-MM-DD YYYY-MM-DD",
        }),
      }),
    );

    prompt.props.onConfirm(" 2026-01-01 2026-01-15 ");
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "tokens_between",
        arguments: "2026-01-01 2026-01-15",
      }),
    );
  });

  it("registers sidebar_content and compact slots independently", async () => {
    const plugin = await loadTuiModule();
    const sidebarOnly = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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

    const rendered = sidebarRegistration!.slots.sidebar_content({}, { session_id: "session-1" }) as any;
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

    compactRegistration!.slots.home_bottom({}, {});
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

  it("wraps api.ui.Prompt and forwards session prompt props and ref exactly", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    const onSubmit = vi.fn();
    const ref = vi.fn();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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
