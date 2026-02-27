import { describe, expect, it, vi } from "vitest";

import { qwenCodeProvider } from "../src/providers/qwen-code.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  readQwenLocalQuotaState: vi.fn(),
  computeQwenQuota: vi.fn(),
}));

describe("qwen-code provider", () => {
  it("returns attempted:false when oauth auth is not configured", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({});

    const out = await qwenCodeProvider.fetch({ config: {} } as any);
    expect(out.attempted).toBe(false);
    expect(out.entries).toEqual([]);
  });

  it("maps local quota into grouped entries", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeQwenQuota, readQwenLocalQuotaState } = await import("../src/lib/qwen-local-quota.js");

    (readAuthFileCached as any).mockResolvedValue({
      "opencode-qwencode-auth": { type: "oauth", access: "token" },
    });
    (readQwenLocalQuotaState as any).mockResolvedValue({});
    (computeQwenQuota as any).mockReturnValue({
      day: {
        used: 42,
        limit: 1000,
        percentRemaining: 96,
        resetTimeIso: "2026-02-25T00:00:00.000Z",
      },
      rpm: {
        used: 5,
        limit: 60,
        percentRemaining: 92,
        resetTimeIso: "2026-02-24T12:00:30.000Z",
      },
    });

    const out = await qwenCodeProvider.fetch({ config: { toastStyle: "grouped" } } as any);

    expect(out.attempted).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      name: "Qwen Daily",
      group: "Qwen (OAuth)",
      label: "Daily:",
      right: "42/1000",
      percentRemaining: 96,
    });
    expect(out.entries[1]).toMatchObject({
      name: "Qwen RPM",
      group: "Qwen (OAuth)",
      label: "RPM:",
      right: "5/60",
      percentRemaining: 92,
    });
  });

  it("matches qwen-code model ids", () => {
    expect(qwenCodeProvider.matchesCurrentModel?.("qwen-code/qwen3-coder-plus")).toBe(true);
    expect(qwenCodeProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });
});
