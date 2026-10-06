import { describe, expect, it } from "vitest";

import { keepRetiredModels } from "../scripts/refresh-modelsdev-pricing.mjs";

function snapshot(providers: Record<string, Record<string, { input: number; output: number }>>) {
  return {
    _meta: {
      generatedAt: 1,
      providers: Object.keys(providers),
      source: "https://models.dev/api.json",
      units: "USD per 1M tokens",
    },
    providers,
  };
}

describe("refresh-modelsdev-pricing keepRetiredModels", () => {
  it("keeps priced models that models.dev dropped, and models.dev prices win", () => {
    const fresh = snapshot({ anthropic: { "claude-new": { input: 1, output: 2 } } });
    const previous = snapshot({
      anthropic: {
        "claude-new": { input: 9, output: 9 },
        "claude-old": { input: 3, output: 15 },
      },
      xai: { "grok-old": { input: 2, output: 10 } },
    });

    const kept = keepRetiredModels(fresh, previous, ["anthropic", "xai"]);

    expect(kept).toEqual(["anthropic/claude-old", "xai/grok-old"]);
    expect(fresh.providers).toEqual({
      anthropic: {
        "claude-new": { input: 1, output: 2 },
        "claude-old": { input: 3, output: 15 },
      },
      xai: { "grok-old": { input: 2, output: 10 } },
    });
    expect(fresh._meta.providers).toEqual(["anthropic", "xai"]);
  });

  it("ignores providers outside the requested list and a missing previous file", () => {
    const fresh = snapshot({ openai: { "gpt-new": { input: 1, output: 2 } } });
    const previous = snapshot({ zai: { "glm-old": { input: 1, output: 1 } } });

    expect(keepRetiredModels(fresh, previous, ["openai"])).toEqual([]);
    expect(keepRetiredModels(fresh, null, ["openai"])).toEqual([]);
    expect(Object.keys(fresh.providers)).toEqual(["openai"]);
  });
});
