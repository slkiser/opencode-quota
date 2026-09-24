import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveQuotaRuntimeContext = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-runtime-context.js")>()),
  resolveQuotaRuntimeContext,
}));

import plugin from "../src/tui-v2.tsx";

describe("V2 CLI question-tool accounting boundary", () => {
  const handlers = new Map<string, (event: { data: Record<string, unknown> }) => void>();
  const client = { session: { get: vi.fn() } };
  const toast = vi.fn();

  beforeEach(() => {
    handlers.clear();
    client.session.get.mockReset();
    toast.mockReset();
    resolveQuotaRuntimeContext.mockReset().mockResolvedValue({
      config: { enabled: true, enableToast: true, showOnQuestion: false },
    });
    plugin.setup({
      client,
      data: {
        on: (name: string, handler: (event: { data: Record<string, unknown> }) => void) => {
          handlers.set(name, handler);
          return () => handlers.delete(name);
        },
      },
      keymap: { layer: vi.fn() },
      ui: {
        slot: (claim: { append: string; render: () => unknown }) => {
          if (claim.append === "app") claim.render();
          return vi.fn();
        },
        toast: { show: toast },
      },
    } as never);
  });

  it("does not treat a successful question-tool execution as a completed model request", async () => {
    handlers.get("session.tool.input.started")?.({ data: { name: "question", id: "call-1" } });
    handlers.get("session.tool.success")?.({ data: { sessionID: "session-1", id: "call-1" } });
    await vi.waitFor(() => expect(resolveQuotaRuntimeContext).toHaveBeenCalledTimes(1));
    expect(client.session.get).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not use question-tool failure metadata as accounting authority", () => {
    handlers.get("session.tool.input.started")?.({ data: { name: "question", id: "call-2" } });
    handlers.get("session.tool.failed")?.({ data: { sessionID: "session-1", id: "call-2" } });
    expect(resolveQuotaRuntimeContext).not.toHaveBeenCalled();
    expect(client.session.get).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
