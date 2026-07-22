import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginMocks = vi.hoisted(() => ({
  QuotaToastPlugin: vi.fn(),
}));

vi.mock("../src/plugin.js", () => ({
  QuotaToastPlugin: pluginMocks.QuotaToastPlugin,
}));

describe("package entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports the V1 plugin module shape on the default export", async () => {
    const mod = await import("../src/index.js");

    expect(mod.default).toEqual({
      id: "@slkiser/opencode-quota",
      server: pluginMocks.QuotaToastPlugin,
    });
    expect(mod.QuotaToastPlugin).toBe(pluginMocks.QuotaToastPlugin);
    expect(mod.QUOTA_PROVIDER_REMOTE_FORMATS).toEqual(["quota-v1", "openrouter-key-v1", "json-v1"]);
    expect(JSON.stringify(mod.QUOTA_PROVIDER_REMOTE_FORMATS)).not.toContain(
      ["accounting", "v1"].join("-"),
    );
  });
});
