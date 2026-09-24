import { describe, expect, it, vi } from "vitest";

const buildOutput = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-dialog-commands.js", () => ({
  buildQuotaDialogCommandOutput: buildOutput,
}));

import plugin from "../src/plugin.js";

describe("V2 server plugin", () => {
  it("registers a structured quota diagnostics tool without a server toast dependency", async () => {
    let registered:
      | {
          name: string;
          execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
        }
      | undefined;
    const ctx = {
      location: { directory: "/tmp/opencode/quota-plugin-v2" },
      provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai" }] }) },
      session: {
        get: vi.fn().mockResolvedValue({ model: { id: "gpt-5", providerID: "openai" } }),
      },
      tool: {
        transform: vi.fn(async (callback) => {
          callback({
            add: (tool: typeof registered) => {
              registered = tool;
            },
          });
        }),
      },
    };
    buildOutput.mockResolvedValue({ state: "output", output: "Quota ready" });

    await plugin.setup(ctx as never);
    expect(registered?.name).toBe("quota_status");
    const output = await registered?.execute({ force: true }, { sessionID: "session-test" });
    expect(output).toEqual({ content: "Quota ready" });
    expect(buildOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota_status",
        sessionID: "session-test",
        arguments: '{"force":true}',
      }),
    );
    expect(ctx.provider.list).toHaveBeenCalledTimes(0);
  });
});
