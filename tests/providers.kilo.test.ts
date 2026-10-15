import { describe, it, expect, vi } from "vitest";
const auth = vi.hoisted(() => ({ resolve: vi.fn(), has: vi.fn() }));
vi.mock("../src/lib/kilo-config.js", () => ({
  resolveKiloApiKey: auth.resolve,
  hasKiloApiKey: auth.has,
}));
vi.mock("../src/providers/registry.js", () => ({ getProviders: () => [kiloProvider] }));
import { kiloProvider } from "../src/providers/kilo.js";
import { fetchAllQuota } from "../src/gui/ipc/quota.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { projectAccountingDetails } from "../src/lib/accounting-display.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
const ctx = { config: { requestTimeoutMs: 1000 } } as any;
describe("Kilo provider surfaces", () => {
  it("does not attempt without an API-key source and uses the Kilo runtime id", async () => {
    auth.resolve.mockResolvedValue(null);
    auth.has.mockResolvedValue(false);
    expect(await kiloProvider.isAvailable(ctx)).toBe(false);
    expect(await kiloProvider.fetch(ctx)).toEqual({ attempted: false, entries: [], errors: [] });
    expect(kiloProvider.matchesCurrentModel("kilo/anthropic/claude")).toBe(true);
    expect(kiloProvider.matchesCurrentModel("openai/gpt")).toBe(false);
  });
  it("shares balance units across desktop IPC, command, sidebar and toast without a synthetic quota percent", async () => {
    auth.resolve.mockResolvedValue({ key: "fixture-key", source: "env:KILO_API_KEY" });
    auth.has.mockResolvedValue(true);
    const remote = vi.fn(
      async (url: unknown) =>
        new Response(
          JSON.stringify(
            String(url).includes("profile/balance")
              ? { balance: 12.5 }
              : [{ result: { data: { json: { subscription: null } } } }],
          ),
        ),
    );
    vi.stubGlobal("fetch", remote);
    const provider = await kiloProvider.fetch(ctx);
    const data = {
      entries: provider.entries,
      errors: [],
      accountingDetails: projectAccountingDetails("kilo", provider),
    };
    for (const text of [
      formatQuotaCommand(data),
      formatQuotaRows({ version: "fixture", ...data }),
      buildSidebarQuotaPanelLines({ data, config: DEFAULT_CONFIG }).join("\n"),
    ])
      expect(text).toContain("USD 12.5");
    const desktop = await fetchAllQuota({ ...DEFAULT_CONFIG, enabledProviders: ["kilo"] }, true);
    expect(desktop.entries).toEqual(provider.entries);
    expect(desktop.entries[0]).not.toHaveProperty("percentRemaining");
    expect(desktop.accountingDetails?.[0].accountIdentity).toBe("unknown");
    expect(JSON.stringify(desktop)).not.toContain("fixture-key");
    expect(remote).toHaveBeenCalledTimes(4);
  });
});
