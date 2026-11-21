import { describe, expect, it } from "vite-plus/test";
import { decodePluginQuota, pluginQuotaRpc } from "../src/lib/plugin-quota-rpc.js";
import { validateQuotaProviders } from "../src/lib/quota-providers.js";
import { checkDefinition } from "../src/providers/quota-providers.js";

describe("custom plugin RPC quota", () => {
  it("keeps the OpenCode provider ID separate from the custom definition ID", () => {
    const input = { id: "personal", providerId: "my-provider", mode: "plugin-rpc" };
    expect(validateQuotaProviders([input]).value).toEqual([{ ...input, label: "personal" }]);
    expect(validateQuotaProviders([{ ...input, url: "https://example.com/" }]).issues).not.toEqual(
      [],
    );
  });

  it("maps used bars to remaining quota and renders label groups as text", () => {
    expect(
      decodePluginQuota({
        label: "Provider",
        groups: [
          { title: "Plan", value: "Personal" },
          { title: "Monthly", bar: "75%", resetTime: 1797264000000 },
          { title: "Daily", bar: "2.5K/5,000" },
        ],
      }),
    ).toMatchObject([
      { key: "window-1", type: "status", text: "Personal" },
      { key: "window-2", percentRemaining: 25, resetsAt: "2026-12-14T16:00:00.000Z" },
      { key: "window-3", percentRemaining: 50 },
    ]);
  });

  it("does not turn missing or invalid data into quota", () => {
    expect(decodePluginQuota({ label: "Provider", groups: [] })).toEqual([]);
    for (const bar of ["NaN%", "25/0", "-1%", "1,00/500"]) {
      expect(() =>
        decodePluginQuota({ label: "Provider", groups: [{ title: "Monthly", bar }] }),
      ).toThrow();
    }
  });

  it("reads the selected provider and does not copy RPC error details", async () => {
    const definition = {
      id: "personal",
      label: "Personal",
      providerId: "my-provider",
      mode: "plugin-rpc",
    } as const;
    const result = await checkDefinition(definition, "/synthetic", 1000, async (id, signal) => {
      expect(signal.aborted).toBe(false);
      expect(pluginQuotaRpc(id).id).toBe("my-provider.quota");
      return { label: "Provider", groups: [{ title: "Daily", bar: "100%" }] };
    });
    expect(result.account.rows).toMatchObject([
      { key: "custom.personal.window-1", percentRemaining: 0 },
    ]);
    const rejected = await checkDefinition(definition, "/synthetic", 1000, async () => {
      throw new Error("private upstream message");
    });
    expect(rejected.failure).toBe("Plugin quota RPC unavailable");
    expect(JSON.stringify(rejected)).not.toContain("private upstream message");
  });
});
