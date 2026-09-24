import { beforeEach, describe, expect, it, vi } from "vitest";

import { QUOTA_DIALOG_COMMANDS } from "../src/lib/quota-dialog-commands.js";
import tuiPlugin from "../src/tui-v2.js";

const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>()),
  buildQuotaDialogCommandOutput: mocks.build,
}));

function startTui() {
  const commands = new Map<
    string,
    { run: (input?: unknown) => Promise<void>; slash: { name: string } }
  >();
  const listeners = new Map<string, (event: { data?: Record<string, unknown> }) => void>();
  const alert = vi.fn().mockResolvedValue(undefined);
  const prompt = vi.fn().mockResolvedValue(undefined);
  const toast = vi.fn();
  const slots = new Map<string, { render: (props?: { sessionID: string }) => unknown }>();
  const context = {
    location: { directory: process.cwd() },
    client: { session: { get: vi.fn() } },
    data: {
      on: vi.fn((name: string, callback: (event: { data?: Record<string, unknown> }) => void) => {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      }),
    },
    keymap: {
      layer: vi.fn(
        (
          build: () => {
            commands: Array<{
              id: string;
              run: (input?: unknown) => Promise<void>;
              slash: { name: string };
            }>;
          },
        ) => {
          for (const command of build().commands) commands.set(command.id, command);
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
      dialog: { alert, prompt, set: vi.fn() },
    },
  };
  const dispose = tuiPlugin.setup(context as never);
  return { commands, listeners, alert, prompt, toast, slots, context, dispose };
}

describe("V2 CLI command boundary", () => {
  beforeEach(() => {
    mocks.build.mockReset().mockResolvedValue({
      state: "output",
      title: "Quota",
      output: "Quota ready",
      dialogSize: "large",
    });
  });

  it("registers the 12 local slash commands, not V1 server command hooks", () => {
    const tui = startTui();
    expect(tui.commands.size).toBe(12);
    expect([...tui.commands.values()].map((item) => item.slash.name)).toEqual(
      QUOTA_DIALOG_COMMANDS.map((item) => item.slashName),
    );
    expect(new Set(QUOTA_DIALOG_COMMANDS.map((item) => item.id)).size).toBe(12);
    expect(tui.context.ui.slot).toHaveBeenCalledWith(expect.objectContaining({ append: "app" }));
    tui.dispose?.();
  });

  it("isolates commands from the model transcript and presents quota output locally", async () => {
    const tui = startTui();
    await tui.commands.get("quota.quota")?.run();
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota",
        sessionID: undefined,
        roots: { fallbackDirectory: process.cwd() },
      }),
    );
    expect(tui.alert).toHaveBeenCalledWith({ title: "Quota", message: "Quota ready" });
    expect(tui.context.client.session.get).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("passes explicit /tokens_between arguments to the deterministic output builder", async () => {
    const tui = startTui();
    await tui.commands.get("quota.tokens_between")?.run({ arguments: "not-a-date-range" });
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "tokens_between",
        arguments: "not-a-date-range",
      }),
    );
    expect(tui.prompt).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("prompts for missing date ranges and does not invoke the command when cancelled", async () => {
    const tui = startTui();
    await tui.commands.get("quota.tokens_between")?.run();
    expect(tui.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ placeholder: "YYYY-MM-DD YYYY-MM-DD" }),
    );
    expect(mocks.build).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("returns without a dialog when quota is disabled", async () => {
    mocks.build.mockResolvedValue({ state: "noop", command: "quota", reason: "disabled" });
    const tui = startTui();
    await tui.commands.get("quota.quota")?.run();
    expect(tui.alert).not.toHaveBeenCalled();
    expect(tui.toast).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("shows command failures as sanitized TUI error toasts rather than injecting a message", async () => {
    mocks.build.mockRejectedValue(new Error("quota unavailable"));
    const tui = startTui();
    await tui.commands.get("quota.quota")?.run();
    expect(tui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "error",
        message: "quota unavailable",
      }),
    );
    expect(tui.alert).not.toHaveBeenCalled();
    tui.dispose?.();
  });

  it("does not offer V1 web/server slash interception or agent-config normalization", async () => {
    // V2 CLI commands are local keymap registrations. The server plugin only provides a tool;
    // there is no V2 server command.execute.before hook to inject output into web sessions.
    const server = (await import("../src/plugin.js")).default;
    const transform = vi.fn();
    await server.setup({
      location: { directory: process.cwd() },
      tool: { transform },
      provider: { list: vi.fn() },
    } as never);
    expect(transform).toHaveBeenCalledOnce();
    expect((server as Record<string, unknown>)["command.execute.before"]).toBeUndefined();
    expect((server as Record<string, unknown>).config).toBeUndefined();
  });
});
