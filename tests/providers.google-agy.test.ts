// Which OpenCode provider ids belong to Google AGY, and which models the provider claims.
// The `agy` id is the provider the Antigravity bridge registers when it drives the `agy` CLI,
// so a session on one of those models shows the AGY quota rows.
import { describe, expect, it } from "vite-plus/test";

import { AGY_AUTH_KEYS } from "../src/lib/google-agy.js";
import {
  getQuotaProviderIdsForRuntimeId,
  getQuotaProviderRuntimeIds,
} from "../src/lib/provider-metadata.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";

describe("Google AGY runtime ids", () => {
  it("claims the `agy` provider id", () => {
    expect(getQuotaProviderRuntimeIds("google-agy")).toContain("agy");
    expect(getQuotaProviderIdsForRuntimeId("agy")).toEqual(["google-agy"]);
  });

  it("keeps the ids it already claimed", () => {
    for (const id of ["google-agy", "opencode-agy-auth", "google-agy-auth"]) {
      expect(getQuotaProviderIdsForRuntimeId(id)).toEqual(["google-agy"]);
    }
  });

  it("lists `agy` among the auth source keys", () => {
    expect(AGY_AUTH_KEYS).toContain("agy");
  });
});

describe("Google AGY model matching", () => {
  it("claims a model from the `agy` provider", () => {
    expect(googleAgyProvider.matchesCurrentModel("agy/gemini-3.8-flash")).toBe(true);
  });

  it("claims a model from the Antigravity auth providers", () => {
    expect(googleAgyProvider.matchesCurrentModel("google-agy/gemini-3.8-flash")).toBe(true);
    expect(googleAgyProvider.matchesCurrentModel("opencode-agy-auth/gemini-3.8-flash")).toBe(true);
    expect(googleAgyProvider.matchesCurrentModel("google-agy-auth/gemini-3.8-flash")).toBe(true);
  });

  it("claims an `antigravity-…` model on the `google` provider", () => {
    expect(googleAgyProvider.matchesCurrentModel("google/antigravity-gemini")).toBe(true);
  });

  it("leaves other providers' models alone", () => {
    expect(googleAgyProvider.matchesCurrentModel("google/gemini-3.8-flash")).toBe(false);
    expect(googleAgyProvider.matchesCurrentModel("anthropic/claude-sonnet-4-6")).toBe(false);
  });
});
