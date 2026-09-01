import { describe, expect, it, vi } from "vitest";
import { anthropicProvider } from "../src/providers/anthropic.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/anthropic.js", () => ({
  getAnthropicDiagnostics: vi.fn(),
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuota: vi.fn(),
}));

describe("anthropic provider", () => {
  it("reports the credential store that answered the usage probe", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "opencode-auth-oauth-api",
      oauthCredentialSource: "opencode-auth",
      checkedCommands: ["claude --version"],
      quota: {
        success: true,
        five_hour: { percentRemaining: 80 },
        seven_day: { percentRemaining: 70 },
      },
    });
    (queryAnthropicQuota as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
      seven_day: { percentRemaining: 70 },
    });

    const out = await anthropicProvider.fetch({} as any);
    expect(out.statusDetails).toContainEqual({
      key: "oauth_credential_source",
      value: "opencode-auth",
    });
    expect(out.statusDetails).toContainEqual({
      key: "quota_source",
      value: "opencode-auth-oauth-api",
    });
    expect(out.entries).toHaveLength(2);
    expect(out.entries.every((entry) => entry.accounting.acquisitionMethod === "remote_api")).toBe(
      true,
    );
  });

  it("reports no credential store when the OAuth probe was never reached", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: ["claude --version"],
    });
    (queryAnthropicQuota as any).mockResolvedValueOnce(null);

    const out = await anthropicProvider.fetch({} as any);
    expect(out.statusDetails).toContainEqual({
      key: "oauth_credential_source",
      value: "(none)",
    });
  });

  it("returns attempted:false when Anthropic quota is unavailable locally", async () => {
    const { queryAnthropicQuota } = await import("../src/lib/anthropic.js");
    (queryAnthropicQuota as any).mockResolvedValueOnce(null);

    const out = await anthropicProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps local CLI quota windows into canonical grouped-capable rows", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: ["claude --version"],
      quota: {
        success: true,
        five_hour: { percentRemaining: 43 },
        seven_day: { percentRemaining: 88 },
      },
    });
    (queryAnthropicQuota as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 43, resetTimeIso: "2026-03-25T18:00:00.000Z" },
      seven_day: { percentRemaining: 88, resetTimeIso: "2026-04-01T00:00:00.000Z" },
    });

    const out = await anthropicProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "anthropic")).toEqual([
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
    expect(out.entries.every((entry) => entry.accounting.acquisitionMethod === "local_cli")).toBe(
      true,
    );
    expect(out.presentation).toBeUndefined();
  });

  it("reports enabled Usage Credits as a third remote API quota row", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "opencode-auth-oauth-api",
      oauthCredentialSource: "opencode-auth",
      checkedCommands: ["claude --version"],
      quota: {
        success: true,
        five_hour: { percentRemaining: 43 },
        seven_day: { percentRemaining: 88 },
        extra_usage: { percentRemaining: 62 },
      },
    });
    (queryAnthropicQuota as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 43, resetTimeIso: "2026-03-25T18:00:00.000Z" },
      seven_day: { percentRemaining: 88, resetTimeIso: "2026-04-01T00:00:00.000Z" },
      extra_usage: { percentRemaining: 62 },
    });

    const out = await anthropicProvider.fetch({} as any);

    expect(visibleEntries(out.entries, "anthropic")).toEqual([
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
      {
        name: "Claude Usage Credits",
        group: "Claude",
        label: "Monthly:",
        percentRemaining: 62,
      },
    ]);
    expect(out.entries.every((entry) => entry.accounting.acquisitionMethod === "remote_api")).toBe(
      true,
    );
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
    expect(out.entries).toHaveLength(2);
    expect(visibleEntries(out.entries, "anthropic")).toEqual([
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
      anthropicProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["anthropic"] }),
      ),
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
