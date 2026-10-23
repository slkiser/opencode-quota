import { describe, expect, it, vi } from "vite-plus/test";

import {
  isAnyProviderIdAvailable,
  isCanonicalProviderAvailable,
} from "../src/lib/provider-availability.js";
import type { CanonicalQuotaProviderId } from "../src/lib/provider-metadata.js";
import { createRuntimeProviderIdResolver } from "../src/lib/runtime-provider-ids.js";

function makeCtx(params: { ids?: string[]; error?: Error }) {
  const providers = params.error
    ? vi.fn().mockRejectedValue(params.error)
    : vi.fn().mockResolvedValue({
        data: { providers: (params.ids ?? []).map((id) => ({ id })) },
      });
  const client = { config: { providers } } as any;
  return { client, resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client) } as any;
}

function available(providerId: CanonicalQuotaProviderId, ids: string[]): Promise<boolean> {
  return isCanonicalProviderAvailable({
    ctx: makeCtx({ ids }),
    providerId,
    fallbackOnError: false,
  });
}

describe("provider availability", () => {
  it("matches any configured provider id from a candidate list", async () => {
    await expect(
      isAnyProviderIdAvailable({
        ctx: makeCtx({ ids: ["openai", "github-copilot-chat"] }),
        candidateIds: ["copilot", "github-copilot-chat"],
        fallbackOnError: false,
      }),
    ).resolves.toBe(true);
  });

  it.each<[CanonicalQuotaProviderId, string, boolean]>([
    ["copilot", "github-copilot-chat", true],
    ["openai", "chatgpt", true],
    ["openai", "opencode", false],
    ["zai", "glm", true],
    ["alibaba-coding-plan", "alibaba-coding-plan", true],
    ["alibaba-token-plan", "alibaba", false],
    ["alibaba-token-plan", "alibaba-coding-plan", false],
    ["alibaba-token-plan", "alibaba-token-plan", true],
    ["deepseek", "deepseek", true],
    ["google-gemini-cli", "google-gemini-cli", true],
    ["google-gemini-cli", "gemini-cli", true],
    ["google-gemini-cli", "gemini", true],
    ["google-gemini-cli", "opencode-gemini-auth", true],
    ["google-gemini-cli", "google", true],
    ["minimax-coding-plan", "minimax", true],
    ["minimax-china-coding-plan", "minimax-cn-coding-plan", true],
    ["minimax-china-coding-plan", "minimax", false],
    ["xiaomi", "xiaomi", true],
    ["xiaomi", "xiaomi-token-plan-cn", true],
    ["xiaomi", "xiaomi-token-plan-ams", true],
    ["xiaomi", "xiaomi-token-plan-sgp", true],
    ["xiaomi", "mimo", false],
    // A broad normalization alias is not a runtime provider id.
    ["anthropic", "claude", false],
  ])("%s is available with OpenCode provider %s: %s", async (providerId, runtimeId, expected) => {
    await expect(available(providerId, [runtimeId])).resolves.toBe(expected);
  });

  it("returns false when no candidate provider ids are configured", async () => {
    await expect(available("cursor", [])).resolves.toBe(false);
  });

  it("reuses one runtime-provider snapshot across concurrent availability checks", async () => {
    const ctx = makeCtx({ ids: ["copilot", "openai"] });

    await expect(
      Promise.all(
        (["copilot", "openai"] as const).map((providerId) =>
          isCanonicalProviderAvailable({ ctx, providerId, fallbackOnError: false }),
        ),
      ),
    ).resolves.toEqual([true, true]);
    expect(ctx.client.config.providers).toHaveBeenCalledOnce();
  });

  it("shares a rejected lookup while keeping each caller's fallback policy", async () => {
    const ctx = makeCtx({ error: new Error("boom") });

    await expect(
      Promise.all([
        isCanonicalProviderAvailable({ ctx, providerId: "copilot", fallbackOnError: false }),
        isCanonicalProviderAvailable({ ctx, providerId: "openai", fallbackOnError: true }),
      ]),
    ).resolves.toEqual([false, true]);
    expect(ctx.client.config.providers).toHaveBeenCalledOnce();
  });
});
