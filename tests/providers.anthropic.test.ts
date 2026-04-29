import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { anthropicProvider } from "../src/providers/anthropic.js";

vi.mock("../src/lib/anthropic.js", () => ({
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuota: vi.fn(),
}));

describe("anthropic provider", () => {
  it("returns attempted:false when Anthropic quota is unavailable locally", async () => {
    const { queryAnthropicQuota } = await import("../src/lib/anthropic.js");
    (queryAnthropicQuota as any).mockResolvedValueOnce(null);

    const out = await anthropicProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps quota windows into canonical grouped-capable rows", async () => {
    const { queryAnthropicQuota } = await import("../src/lib/anthropic.js");
    (queryAnthropicQuota as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 43, resetTimeIso: "2026-03-25T18:00:00.000Z" },
      seven_day: { percentRemaining: 88, resetTimeIso: "2026-04-01T00:00:00.000Z" },
    });

    const out = await anthropicProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        percentRemaining: 43,
        resetTimeIso: "2026-03-25T18:00:00.000Z",
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        percentRemaining: 88,
        resetTimeIso: "2026-04-01T00:00:00.000Z",
      },
    ]);
    expect(out.presentation).toBeUndefined();
  });

  it("defaults to canonical grouped-capable rows when no style is specified", async () => {
    const { queryAnthropicQuota } = await import("../src/lib/anthropic.js");
    (queryAnthropicQuota as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 50, resetTimeIso: "2026-03-25T18:00:00.000Z" },
      seven_day: { percentRemaining: 70, resetTimeIso: "2026-04-01T00:00:00.000Z" },
    });

    const out = await anthropicProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        percentRemaining: 50,
        resetTimeIso: "2026-03-25T18:00:00.000Z",
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        percentRemaining: 70,
        resetTimeIso: "2026-04-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps errors into toast errors", async () => {
    const { queryAnthropicQuota } = await import("../src/lib/anthropic.js");
    (queryAnthropicQuota as any).mockResolvedValueOnce({
      success: false,
      error:
        "Invalid or expired Anthropic token; re-authenticate Claude Code or update CLAUDE_CODE_OAUTH_TOKEN",
    });

    const out = await anthropicProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Claude");
  });

  it("matches anthropic/ model ids", () => {
    expect(anthropicProvider.matchesCurrentModel?.("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("anthropic/claude-opus-4-6")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("ANTHROPIC/claude-haiku-4-5")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
    expect(anthropicProvider.matchesCurrentModel?.("copilot/claude-sonnet-4-5")).toBe(false);
  });

  it("is available only when provider ids include anthropic and Claude CLI auth is ready", async () => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(true);

    await expect(
      anthropicProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["anthropic"] })),
    ).resolves.toBe(true);
    await expect(
      anthropicProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["claude"] })),
    ).resolves.toBe(false);
    await expect(
      anthropicProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(false);
    await expect(
      anthropicProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["copilot", "anthropic"] }),
      ),
    ).resolves.toBe(true);
  });

  it("passes the configured Claude binary path through Anthropic probes", async () => {
    const { hasAnthropicCredentialsConfigured, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(true);
    (queryAnthropicQuota as any).mockResolvedValueOnce(null);

    const ctx = createProviderAvailabilityContext({
      providerIds: ["anthropic"],
      configOverrides: {
        anthropicBinaryPath: "/opt/claude/bin/claude",
      },
    });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasAnthropicCredentialsConfigured).toHaveBeenCalledWith({
      binaryPath: "/opt/claude/bin/claude",
    });

    await anthropicProvider.fetch(ctx);
    expect(queryAnthropicQuota).toHaveBeenCalledWith({
      binaryPath: "/opt/claude/bin/claude",
    });
  });

  it("is not available when Claude CLI auth is missing even if provider id exists", async () => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(false);

    const ctx = createProviderAvailabilityContext({ providerIds: ["anthropic"] });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
  });

  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
  });
});
