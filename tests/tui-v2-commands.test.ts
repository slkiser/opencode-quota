import { describe, expect, it, vi } from "vitest";

import plugin from "../src/tui-v2.tsx";

describe("V2 quota TUI commands", () => {
  it("registers every quota command as a local slash command", () => {
    let layer:
      | { commands: Array<{ slash: { name: string }; palette: boolean; run: () => void }> }
      | undefined;
    const context = {
      client: {},
      data: { on: vi.fn(() => vi.fn()) },
      keymap: {
        layer: vi.fn((build) => {
          layer = build();
        }),
      },
      ui: {
        slot: vi.fn((claim) => {
          if (claim.append === "app") claim.render();
          return vi.fn();
        }),
        toast: { show: vi.fn() },
        dialog: { alert: vi.fn(), prompt: vi.fn(), set: vi.fn() },
      },
    };

    plugin.setup(context as any);

    expect(layer?.commands.map((command) => command.slash.name)).toEqual([
      "quota",
      "quota_status",
      "quota_announcements",
      "pricing_refresh",
      "tokens_today",
      "tokens_daily",
      "tokens_weekly",
      "tokens_monthly",
      "tokens_all",
      "tokens_session",
      "tokens_session_all",
      "tokens_between",
    ]);
    expect(layer?.commands.every((command) => command.palette)).toBe(true);
    expect(context.ui.slot).toHaveBeenCalledWith(expect.objectContaining({ append: "app" }));
    expect(context.ui.slot).toHaveBeenCalledWith(
      expect.objectContaining({ append: "sidebar.content" }),
    );
    expect(context.data.on.mock.calls.map(([event]) => event)).toEqual([
      "session.step.ended",
      "session.compaction.ended",
      "session.tool.input.started",
      "session.tool.success",
      "session.tool.failed",
    ]);
  });
});
