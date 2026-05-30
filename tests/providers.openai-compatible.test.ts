import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { openaiCompatibleProvider } from "../src/providers/openai-compatible.js";

vi.mock("../src/lib/openai-compatible.js", () => ({
  queryGatewayQuota: vi.fn(),
}));

vi.mock("../src/lib/openai-compatible-config.js", () => ({
  resolveGatewayApiKey: vi.fn(),
  hasGatewayApiKey: vi.fn(),
  resolveGatewayBaseURL: vi.fn(),
}));

function ctxWith(gateways: unknown): any {
  return { config: { openaiCompatibleGateways: gateways } };
}

describe("openai-compatible provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when no gateways are configured", async () => {
    const out = await openaiCompatibleProvider.fetch(ctxWith([]));
    expectNotAttempted(out);
  });

  it("returns attempted:false when configured gateways have no key", async () => {
    const { resolveGatewayApiKey } = await import("../src/lib/openai-compatible-config.js");
    (resolveGatewayApiKey as any).mockResolvedValue(null);

    const out = await openaiCompatibleProvider.fetch(ctxWith([{ providerId: "apigee" }]));
    expectNotAttempted(out);
  });

  it("maps a neutral gateway response into token + cost entries", async () => {
    const { resolveGatewayApiKey, resolveGatewayBaseURL } = await import(
      "../src/lib/openai-compatible-config.js"
    );
    const { queryGatewayQuota } = await import("../src/lib/openai-compatible.js");
    (resolveGatewayApiKey as any).mockResolvedValue({ key: "k", source: "env" });
    (resolveGatewayBaseURL as any).mockResolvedValue("https://gw/llm/v1");
    (queryGatewayQuota as any).mockResolvedValue({
      success: true,
      label: "COMP 318",
      tokens: { limit: 5000000, used: 250000, remaining: 4750000, resetTimeIso: "2026-05-31T00:00:00Z" },
      cost: { currency: "USD", limit: 5, used: 0.42, remaining: 4.58 },
    });

    const out = await openaiCompatibleProvider.fetch(ctxWith([{ providerId: "apigee", label: "COMP 318" }]));
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);

    const tokenEntry = out.entries[0] as any;
    expect(tokenEntry.label).toBe("Tokens:");
    expect(tokenEntry.percentRemaining).toBe(95);
    expect(tokenEntry.resetTimeIso).toBe("2026-05-31T00:00:00Z");

    const costEntry = out.entries[1] as any;
    expect(costEntry.kind).toBe("value");
    expect(costEntry.value).toContain("/");
  });

  it("maps a gateway error into a quota error", async () => {
    const { resolveGatewayApiKey, resolveGatewayBaseURL } = await import(
      "../src/lib/openai-compatible-config.js"
    );
    const { queryGatewayQuota } = await import("../src/lib/openai-compatible.js");
    (resolveGatewayApiKey as any).mockResolvedValue({ key: "k", source: "env" });
    (resolveGatewayBaseURL as any).mockResolvedValue("https://gw/llm/v1");
    (queryGatewayQuota as any).mockResolvedValue({ success: false, error: "gateway quota error 401" });

    const out = await openaiCompatibleProvider.fetch(ctxWith([{ providerId: "apigee", label: "COMP 318" }]));
    expectAttemptedWithErrorLabel(out, "COMP 318");
  });

  it("flags a missing base URL", async () => {
    const { resolveGatewayApiKey, resolveGatewayBaseURL } = await import(
      "../src/lib/openai-compatible-config.js"
    );
    (resolveGatewayApiKey as any).mockResolvedValue({ key: "k", source: "env" });
    (resolveGatewayBaseURL as any).mockResolvedValue(null);

    const out = await openaiCompatibleProvider.fetch(ctxWith([{ providerId: "apigee" }]));
    expectAttemptedWithErrorLabel(out, "apigee");
  });

  it("is available when a configured gateway has a key", async () => {
    const { hasGatewayApiKey } = await import("../src/lib/openai-compatible-config.js");
    (hasGatewayApiKey as any).mockResolvedValue(true);

    await expect(openaiCompatibleProvider.isAvailable(ctxWith([{ providerId: "apigee" }]))).resolves.toBe(
      true,
    );
  });

  it("matches the current model by configured gateway provider id", async () => {
    const { hasGatewayApiKey } = await import("../src/lib/openai-compatible-config.js");
    (hasGatewayApiKey as any).mockResolvedValue(false);

    // Populate the provider-id cache via isAvailable, then match.
    await openaiCompatibleProvider.isAvailable(ctxWith([{ providerId: "apigee" }]));
    expect(openaiCompatibleProvider.matchesCurrentModel!("apigee/google/gemini-2.5-flash")).toBe(true);
    expect(openaiCompatibleProvider.matchesCurrentModel!("openai/gpt-4")).toBe(false);
  });
});
