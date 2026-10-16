import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import tuiPlugin from "../src/tui/index.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

// The TUI must never read logins or build reports itself: the server plugin does both.
const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  readAuthFile: vi.fn(),
  readAuthFileCached: vi.fn(),
  readCredentialRows: vi.fn(),
}));
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>()),
  buildQuotaDialogCommandOutput: mocks.build,
}));
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readAuthFile: mocks.readAuthFile,
  readAuthFileCached: mocks.readAuthFileCached,
  readCredentialRows: mocks.readCredentialRows,
}));

// Canned answers of the server plugin's quota RPC.
const rpc = {
  snapshot: vi.fn(),
  refresh: vi.fn(),
  notices: vi.fn(),
  events: { on: vi.fn(() => () => {}) },
};
const SNAPSHOT = {
  version: 6,
  providers: [
    {
      providerId: "copilot",
      label: "Copilot",
      rows: [
        {
          id: "copilot.allowance",
          providerId: "copilot",
          label: "Plan",
          type: "quota",
          method: "remote_api",
          authority: "provider_reported",
          prominence: "primary",
          percentRemaining: 81,
        },
      ],
      okAtMs: 1,
      refreshing: false,
      debug: [],
    },
  ],
  settings: { values: { "toast.afterReply": "always" }, providers: [], custom: [] },
  resetNotices: [],
  generatedAtMs: 1,
};

function startTui() {
  const commands = new Map<string, { run: () => Promise<void>; slash?: { name: string } }>();
  const listeners = new Map<string, (event: { data?: Record<string, unknown> }) => void>();
  const show = vi.fn((_render: () => unknown, onClose?: () => void) => onClose?.());
  const set = vi.fn();
  const prompt = vi.fn().mockResolvedValue(undefined);
  const toast = vi.fn();
  const slots = new Map<string, { render: (props?: { sessionID: string }) => unknown }>();
  const context = {
    location: { directory: process.cwd() },
    client: { rpc: vi.fn(() => rpc) },
    renderer: { width: 120 },
    theme: { text: { base: "base", muted: "muted" } },
    storage: {
      store: (_key: string, options: { initial: unknown }) => [options.initial, async () => {}],
    },
    data: {
      session: { get: vi.fn() },
      on: vi.fn((name: string, callback: (event: { data?: Record<string, unknown> }) => void) => {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      }),
    },
    keymap: {
      layer: vi.fn(
        (
          build: () => {
            mode?: string;
            commands: Array<{ id: string; run: () => Promise<void>; slash?: { name: string } }>;
          },
        ) => {
          // The palette layer; the typed-command Enter layer has no mode.
          const layer = build();
          if (layer.mode !== "global") return;
          for (const command of layer.commands) commands.set(command.id, command);
        },
      ),
    },
    ui: {
      slot: vi.fn(
        (claim: { append: string; render: (props?: { sessionID: string }) => unknown }) => {
          slots.set(claim.append, claim);
          if (claim.append === "app") claim.render();
          return vi.fn();
        },
      ),
      toast: { show: toast },
      router: { current: () => ({ type: "home" }) },
      dialog: { show, clear: vi.fn(), prompt, set },
    },
  };
  const dispose = tuiPlugin.setup(context as never);
  return { commands, listeners, show, set, prompt, toast, slots, context, dispose };
}

describe("V2 CLI command boundary", () => {
  beforeEach(() => {
    rpc.snapshot.mockReset().mockResolvedValue({ snapshot: SNAPSHOT });
    rpc.refresh.mockReset().mockResolvedValue({ snapshot: SNAPSHOT });
    rpc.notices.mockReset().mockResolvedValue({ homeLine: "" });
  });

  it("registers the palette commands, a slash entry only for the TUI-only one, not V1 server command hooks", () => {
    const tui = startTui();
    expect([...tui.commands.keys()]).toEqual([
      "quota.limits",
      "quota.usage",
      "quota.status",
      "quota.settings",
    ]);
    // The server lists /quota, /quota_usage and /quota_status in the "/" list.
    const slashNames = [...tui.commands.values()].flatMap((item) =>
      item.slash ? [item.slash.name] : [],
    );
    expect(slashNames).toEqual(["quota_settings"]);
    expect(tui.context.ui.slot).toHaveBeenCalledWith(expect.objectContaining({ append: "app" }));
    tui.dispose?.();
  });

  it("never reads logins or builds reports in the TUI during setup, surfaces, and palette runs", async () => {
    vi.stubGlobal("React", {
      createElement: (type: unknown, props: Record<string, unknown> | null) =>
        typeof type === "function" ? type(props ?? {}) : { type, props },
    });
    const tui = startTui();
    tui.slots.get("sidebar.content")?.render({ sessionID: "ses_1" });
    tui.slots.get("prompt.footer")?.render({ sessionID: "ses_1" });
    tui.slots.get("home.footer.status")?.render();
    tui.listeners.get("session.execution.succeeded")?.({ data: { sessionID: "ses_1" } });
    for (const command of tui.commands.values()) await command.run();
    // On Home the quota window only says to open a session, and the reply toast shows the quota.
    const toastMessages = () => tui.toast.mock.calls.map(([toast]) => toast.message as string);
    await vi.waitFor(() =>
      expect(
        toastMessages().filter((message) => message.startsWith("Copilot\n  Plan ")),
      ).toHaveLength(1),
    );

    // The surfaces read the server's snapshot over the RPC; one call serves both of ses_1's.
    expect(rpc.snapshot.mock.calls.filter(([input]) => input.sessionID === "ses_1")).toHaveLength(
      1,
    );
    expect(rpc.refresh.mock.calls.map(([input]) => input)).toEqual([
      { reason: "turn", sessionID: "ses_1" },
    ]);
    expect(rpc.notices).toHaveBeenCalledOnce();
    expect(mocks.readAuthFile).not.toHaveBeenCalled();
    expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    expect(mocks.readCredentialRows).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("does not offer V1 slash interception or agent-config normalization", async () => {
    // V2 TUI commands are local keymap registrations. The server plugin registers a tool and
    // V2 server commands for Web and Desktop; it has no V1 command.execute.before hook.
    const server = (await import("../src/plugin.js")).default;
    const transform = vi.fn();
    const commandTransform = vi.fn();
    await server.setup({
      location: { directory: process.cwd() },
      tool: { transform },
      command: { transform: commandTransform },
      session: { hook: vi.fn() },
      provider: { list: vi.fn() },
      rpc: {
        register: vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } })),
      },
      integration: createFakeIntegration([]),
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    } as never);
    expect(transform).toHaveBeenCalledOnce();
    expect(commandTransform).toHaveBeenCalledOnce();
    expect((server as Record<string, unknown>)["command.execute.before"]).toBeUndefined();
    expect((server as Record<string, unknown>).config).toBeUndefined();
  });
});
