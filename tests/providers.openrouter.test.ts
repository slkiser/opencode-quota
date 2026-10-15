import { describe, it, expect, vi } from "vitest";
const auth = vi.hoisted(() => ({ resolve: vi.fn(), has: vi.fn() }));
vi.mock("../src/lib/openrouter-config.js", () => ({
  resolveOpenRouterApiKey: auth.resolve,
  hasOpenRouterApiKey: auth.has,
}));
vi.mock("../src/providers/registry.js", async () => ({ getProviders: () => [openRouterProvider] }));
import { openRouterProvider } from "../src/providers/openrouter.js";
import { fetchAllQuota } from "../src/gui/ipc/quota.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { projectAccountingDetails } from "../src/lib/accounting-display.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
const ctx = { config: { requestTimeoutMs: 1000 } } as any;
describe("OpenRouter shared surfaces", () => {
  it("does not attempt without credentials and matches only the runtime provider", async () => {
    auth.resolve.mockResolvedValue(null);
    auth.has.mockResolvedValue(false);
    expect(await openRouterProvider.isAvailable(ctx)).toBe(false);
    expect(await openRouterProvider.fetch(ctx)).toEqual({
      attempted: false,
      entries: [],
      errors: [],
    });
    expect(openRouterProvider.matchesCurrentModel("openrouter/anthropic/claude-sonnet")).toBe(true);
    expect(openRouterProvider.matchesCurrentModel("openai/gpt")).toBe(false);
  });
  it("carries the same USD cap/spend facts through desktop, command, toast and sidebar", async () => {
    auth.resolve.mockResolvedValue({ key: "fixture-key", source: "env:OPENROUTER_API_KEY" });
    auth.has.mockResolvedValue(true);
    const remote = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { limit: 100, limit_remaining: 75, usage: 250, usage_monthly: 25 },
          }),
        ),
    );
    vi.stubGlobal("fetch", remote);
    const provider = await openRouterProvider.fetch(ctx);
    const data = {
      entries: provider.entries,
      errors: [],
      accountingDetails: projectAccountingDetails("openrouter", provider),
    };
    for (const text of [
      formatQuotaCommand(data),
      formatQuotaRows({ version: "fixture", ...data }),
      buildSidebarQuotaPanelLines({ data, config: DEFAULT_CONFIG }).join("\n"),
    ])
      expect(text).toContain("75%");
    expect(formatQuotaCommand(data)).toContain("USD 250");
    expect(formatQuotaCommand(data)).toContain("env:OPENROUTER_API_KEY");
    const desktop = await fetchAllQuota(
      { ...DEFAULT_CONFIG, enabledProviders: ["openrouter"] },
      true,
    );
    expect(desktop.accountingDetails?.find((row) => row.key.endsWith(":usage"))?.value).toBe(
      "USD 250",
    );
    expect(desktop.entries).toEqual(provider.entries);
    expect(JSON.stringify(desktop)).not.toContain("fixture-key");
    expect(remote).toHaveBeenCalledTimes(2);
  });
});
