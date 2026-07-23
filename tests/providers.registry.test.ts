import { describe, expect, it } from "vitest";

import { getProviders } from "../src/providers/registry.js";

describe("provider registry", () => {
  it("keeps the deprecated Gemini CLI provider registered exactly once", () => {
    const geminiProviders = getProviders().filter(
      (provider) => provider.id === "google-gemini-cli",
    );

    expect(geminiProviders).toHaveLength(1);
  });
});
