import { describe, expect, it, vi } from "vitest";

import { expectAttemptedWithNoErrors, expectNotAttempted } from "./helpers/provider-assertions.js";
import { qwenCodeProvider } from "../src/providers/qwen-code.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  readQwenLocalQuotaState: vi.fn(),
  computeQwenQuota: vi.fn(),
}));

describe("qwen-code provider", () => {
  it("returns attempted:false when qwen free auth is not configured", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({});

    const out = await qwenCodeProvider.fetch({ config: {} } as any);
    expectNotAttempted(out);
  });

  it("ignores native alibaba auth and still requires qwen oauth", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      alibaba: { type: "api", key: "dashscope-key", tier: "lite" },
    });

    const out = await qwenCodeProvider.fetch({ config: {} } as any);
    expectNotAttempted(out);
  });

  it("maps qwen free local quota into grouped entries", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeQwenQuota, readQwenLocalQuotaState } = await import("../src/lib/qwen-local-quota.js");

    (readAuthFileCached as any).mockResolvedValue({
      "qwen-code": { type: "oauth", access: "token" },
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

    const out = await qwenCodeProvider.fetch({ config: { formatStyle: "grouped" } } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      name: "Qwen Free Daily",
      group: "Qwen (free)",
      label: "Daily:",
      right: "42/1000",
      percentRemaining: 96,
    });
    expect(out.entries[1]).toMatchObject({
      name: "Qwen Free RPM",
      group: "Qwen (free)",
      label: "RPM:",
      right: "5/60",
      percentRemaining: 92,
    });
  });

  it("falls back to the legacy qwen auth key when the canonical key is absent", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeQwenQuota, readQwenLocalQuotaState } = await import("../src/lib/qwen-local-quota.js");

    (readAuthFileCached as any).mockResolvedValue({
      "opencode-qwencode-auth": { type: "oauth", access: "legacy-token" },
    });
    (readQwenLocalQuotaState as any).mockResolvedValue({});
    (computeQwenQuota as any).mockReturnValue({
      day: {
        used: 1,
        limit: 1000,
        percentRemaining: 99,
        resetTimeIso: "2026-02-25T00:00:00.000Z",
      },
      rpm: {
        used: 1,
        limit: 60,
        percentRemaining: 98,
        resetTimeIso: "2026-02-24T12:00:30.000Z",
      },
    });

    const out = await qwenCodeProvider.fetch({ config: { formatStyle: "classic" } } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Qwen Free Daily",
        percentRemaining: 99,
        resetTimeIso: "2026-02-25T00:00:00.000Z",
      },
      {
        name: "Qwen Free RPM",
        percentRemaining: 98,
        resetTimeIso: "2026-02-24T12:00:30.000Z",
      },
    ]);
  });

  it("matches qwen-code model ids", () => {
    expect(qwenCodeProvider.matchesCurrentModel?.("qwen-code/qwen3-coder-plus")).toBe(true);
    expect(qwenCodeProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });
});
