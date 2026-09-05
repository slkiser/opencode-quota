import { describe, expect, it, vi } from "vitest";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { projectQuotaProviderResults } from "../src/lib/quota-accounting-projection.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
import { openaiProvider } from "../src/providers/openai.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/openai.js", () => ({
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  hasOpenAIOAuthCached: vi.fn(),
  resolveOpenAIOAuth: vi.fn(() => ({ state: "none" })),
  queryOpenAIQuota: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

describe("openai provider", () => {
  it("passes configured requestTimeoutMs to the query", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce(null);

    await openaiProvider.fetch({ config: { requestTimeoutMs: 12000 } } as any);

    expect(queryOpenAIQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12000 });
  });

  it("returns attempted:false when not configured", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce(null);

    const out = await openaiProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into canonical grouped-capable windows with single-window display metadata", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Pro)",
      windows: {
        hourly: { percentRemaining: 42, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 80, resetTimeIso: "2026-01-07T00:00:00.000Z" },
        monthly: { percentRemaining: 67, resetTimeIso: "2026-02-01T00:00:00.000Z" },
        codeReview: { percentRemaining: 55, resetTimeIso: "2026-01-02T00:00:00.000Z" },
      },
    });

    const out = await openaiProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "openai")).toEqual([
      {
        name: "OpenAI (Pro) 5h",
        group: "OpenAI (Pro)",
        label: "5h:",
        percentRemaining: 42,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Weekly",
        group: "OpenAI (Pro)",
        label: "Weekly:",
        percentRemaining: 80,
        resetTimeIso: "2026-01-07T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Monthly",
        group: "OpenAI (Pro)",
        label: "Monthly:",
        percentRemaining: 67,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Code Review",
        group: "OpenAI (Pro)",
        label: "Code Review:",
        percentRemaining: 55,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(out.entries.at(-1)?.accounting.resultType).toBe("rate_limit");
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "OpenAI (Pro)",
    });
  });

  it("maps errors into toast errors", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await openaiProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "OpenAI");
  });

  it("queries and labels every database credential independently", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota, resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "active-id",
        integrationId: "openai",
        label: "Work",
        active: true,
        value: { type: "oauth", access: "active" },
      },
      {
        id: "other-id",
        integrationId: "openai",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "other" },
      },
    ]);
    (resolveOpenAIOAuth as any).mockImplementation((auth: any) => ({
      state: "configured",
      sourceKey: "openai",
      accessToken: auth.openai.access,
    }));
    (queryOpenAIQuota as any).mockResolvedValue({
      success: true,
      label: "OpenAI (Business)",
      windows: {
        hourly: { percentRemaining: 42 },
        weekly: { percentRemaining: 80 },
        monthly: { percentRemaining: 67 },
        codeReview: { percentRemaining: 55 },
      },
    });

    const out = await openaiProvider.fetch({} as any);

    expect(queryOpenAIQuota).toHaveBeenCalledTimes(2);
    expect(out.entries).toHaveLength(8);
    expect(out.entries.filter((entry) => entry.label === "5h:")).toHaveLength(2);
    expect(projectQuotaProviderResults([out], "allWindows", "summary")).toHaveLength(8);
    const singleWindow = projectQuotaProviderResults([out], "singleWindow", "summary");
    expect(singleWindow).toHaveLength(2);
    expect(singleWindow.map((entry) => entry.accounting.sourceId)).toEqual([
      "active-id",
      "other-id",
    ]);
    expect(
      out.entries.map((entry) => [entry.group, entry.accounting.sourceId]),
    ).toEqual([
      ["[OpenAI Work] (Business)*", "active-id"],
      ["[OpenAI Work] (Business)*", "active-id"],
      ["[OpenAI Work] (Business)*", "active-id"],
      ["[OpenAI Work] (Business)*", "active-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
    ]);
  });

  it.each([
    ["OpenAI", "[OpenAI] (Business)*"],
    ["SEPD", "[OpenAI SEPD] (Business)*"],
    ["default", "[OpenAI] (Business)*"],
  ])("renders DB alias %s literally on sidebar, CLI, and toast", async (label, expected) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota, resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "credential-id",
        integrationId: "openai",
        label,
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ]);
    (resolveOpenAIOAuth as any).mockReturnValue({
      state: "configured",
      sourceKey: "openai",
      accessToken: "token",
    });
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Business)",
      windows: { hourly: { percentRemaining: 42 } },
    });

    const result = await openaiProvider.fetch({ config: {} } as any);
    const data = { entries: result.entries, errors: result.errors };
    const outputs = [
      buildSidebarQuotaPanelLines({
        data,
        config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
      }).join("\n"),
      formatQuotaCommand(data),
      formatQuotaRowsGrouped(data),
    ];

    for (const output of outputs) {
      expect(output).toContain(expected);
      expect(output).not.toContain("[OpenAI (OpenAI)*]");
    }
  });

  it("is available when provider ids include openai/chatgpt/codex", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["chatgpt"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["codex"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["opencode"] })),
    ).resolves.toBe(false);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["zai"] })),
    ).resolves.toBe(false);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledTimes(2);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to native OpenCode auth when provider ids do not include an OpenAI alias", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValueOnce(true);

    const ctx = createProviderAvailabilityContext({ providerIds: ["zai"] });

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to available when provider lookup throws", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).not.toHaveBeenCalled();
  });
});
