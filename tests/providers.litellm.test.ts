import { describe, expect, it, vi } from "vitest";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { litellmProvider } from "../src/providers/litellm.js";

const libMocks = vi.hoisted(() => ({
  resolveStaticApiKey: vi.fn(),
  resolveToken: vi.fn(),
  resolveBaseURL: vi.fn().mockResolvedValue("http://localhost:4000"),
  hasLiteLLMAuthAvailable: vi.fn(),
  queryLiteLLM: vi.fn(),
  buildLiteLLMEntries: vi.fn((data: any) => data.entries || []),
  readAuthFileCached: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/lib/litellm.js", () => libMocks);

describe("litellm provider", () => {
  describe("isAvailable", () => {
    it("returns false when no auth configured", async () => {
      const { hasLiteLLMAuthAvailable } = await import("../src/lib/litellm.js");
      (hasLiteLLMAuthAvailable as any).mockResolvedValueOnce(false);

      const out = await litellmProvider.isAvailable({} as any);
      expect(out).toBe(false);
    });

    it("returns true when auth is available", async () => {
      const { hasLiteLLMAuthAvailable } = await import("../src/lib/litellm.js");
      (hasLiteLLMAuthAvailable as any).mockResolvedValueOnce(true);

      const out = await litellmProvider.isAvailable({} as any);
      expect(out).toBe(true);
    });

    it("returns true for metadata-backed litellm runtime", async () => {
      const out = await litellmProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["litellm"] })
      );
      expect(out).toBe(true);
    });
  });

  describe("fetch", () => {
    it("returns attempted:false when no token available", async () => {
      const { resolveStaticApiKey, resolveToken, readAuthFileCached } = await import("../src/lib/litellm.js");
      (readAuthFileCached as any).mockResolvedValueOnce({});
      (resolveStaticApiKey as any).mockReturnValueOnce(null);
      (resolveToken as any).mockReturnValueOnce(null);

      const out = await litellmProvider.fetch({} as any);
      expectNotAttempted(out);
    });

    it("returns attempted:false when query returns null", async () => {
      const { resolveStaticApiKey, resolveToken, readAuthFileCached, queryLiteLLM, resolveBaseURL } = await import("../src/lib/litellm.js");
      (readAuthFileCached as any).mockResolvedValueOnce({ litellm: { access: "token" } });
      (resolveStaticApiKey as any).mockReturnValueOnce(null);
      (resolveToken as any).mockReturnValueOnce("token");
      (resolveBaseURL as any).mockResolvedValueOnce("http://localhost:4000");
      (queryLiteLLM as any).mockResolvedValueOnce(null);

      const out = await litellmProvider.fetch({ config: {} } as any);
      expectNotAttempted(out);
    });

    it("maps quota result into entries", async () => {
      const { resolveStaticApiKey, resolveToken, readAuthFileCached, queryLiteLLM, buildLiteLLMEntries } = await import("../src/lib/litellm.js");
      (readAuthFileCached as any).mockResolvedValueOnce({ litellm: { access: "token" } });
      (resolveStaticApiKey as any).mockReturnValueOnce(null);
      (resolveToken as any).mockReturnValueOnce("token");
      const { resolveBaseURL } = await import("../src/lib/litellm.js");
      (resolveBaseURL as any).mockResolvedValueOnce("http://localhost:4000");
      (queryLiteLLM as any).mockResolvedValueOnce({
        success: true,
        spend: 100.0,
        budget: 200.0,
        today: { metrics: { spend: 5.0 } },
      });
      (buildLiteLLMEntries as any).mockReturnValueOnce([
        { name: "LiteLLM", label: "Spend:", value: "$100.00 (today: $5.0000)" },
      ]);

      const out = await litellmProvider.fetch({ config: {} } as any);
      expectAttemptedWithNoErrors(out);
      expect(out.entries).toHaveLength(1);
      expect(out.entries[0]).toMatchObject({ name: "LiteLLM", label: "Spend:" });
    });

    it("passes requestTimeoutMs to queryLiteLLM", async () => {
      const { resolveToken, readAuthFileCached, queryLiteLLM, resolveBaseURL } = await import("../src/lib/litellm.js");
      (readAuthFileCached as any).mockResolvedValueOnce({ litellm: { access: "token" } });
      (resolveToken as any).mockReturnValueOnce("token");
      (resolveBaseURL as any).mockResolvedValueOnce("http://localhost:4000");
      (queryLiteLLM as any).mockResolvedValueOnce({ success: true, spend: 0 });

      await litellmProvider.fetch({ config: { requestTimeoutMs: 5000 } } as any);

      expect(queryLiteLLM).toHaveBeenCalledWith("token", "http://localhost:4000", 5000);
    });
  });
});
