import { describe, expect, it } from "vitest";

import {
  buildRefreshedSnapshot,
  keepRetiredModels,
} from "../scripts/refresh-modelsdev-pricing.mjs";

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

  it("drops non-number prices from kept models", () => {
    const fresh = snapshot({ openai: { "gpt-new": { input: 1, output: 2 } } });
    const previous = {
      providers: {
        openai: {
          "gpt-text-price": { input: "3" },
          "gpt-mixed": { input: "3", output: 4 },
        },
      },
    };

    expect(keepRetiredModels(fresh, previous, ["openai"])).toEqual(["openai/gpt-mixed"]);
    expect(fresh.providers.openai).toEqual({
      "gpt-mixed": { output: 4 },
      "gpt-new": { input: 1, output: 2 },
    });
  });
});

describe("refresh-modelsdev-pricing buildRefreshedSnapshot", () => {
  it("refuses a models.dev answer with no priced models instead of keeping everything", () => {
    const previous = snapshot({ anthropic: { "claude-old": { input: 3, output: 15 } } });

    expect(() => buildRefreshedSnapshot({}, previous, ["anthropic"])).toThrow(
      "returned no priced models",
    );
    expect(() =>
      buildRefreshedSnapshot({ anthropic: { models: { x: { cost: {} } } } }, previous, [
        "anthropic",
      ]),
    ).toThrow("returned no priced models");
  });

  it("builds the models.dev snapshot and reports kept models", () => {
    const previous = snapshot({ anthropic: { "claude-old": { input: 3, output: 15 } } });
    const api = { anthropic: { models: { "claude-new": { cost: { input: 1, output: 2 } } } } };

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(api, previous, ["anthropic"]);

    expect(keptModelIDs).toEqual(["anthropic/claude-old"]);
    expect(Object.keys(built.providers.anthropic)).toEqual(["claude-new", "claude-old"]);
  });
});
