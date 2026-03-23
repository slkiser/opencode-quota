import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  listModelsForProvider,
  listProviders,
  lookupCost,
} from "../src/lib/modelsdev-pricing.js";
import {
  CURSOR_OFFICIAL_MODEL_ALIASES,
  lookupCursorLocalCost,
  resolveCursorModel,
} from "../src/lib/cursor-pricing.js";
import { resolvePricingKey } from "../src/lib/quota-stats.js";

const CURSOR_UPSTREAM_MODELS_PATH = new URL(
  "../references/upstream-plugins/opencode-cursor-oauth/dist/models.js",
  import.meta.url,
);

const CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS = new Set<string>();

function getCursorUpstreamFallbackModelIds(): string[] {
  const source = readFileSync(CURSOR_UPSTREAM_MODELS_PATH, "utf8");
  const marker = "const FALLBACK_MODELS = [";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error("Unable to locate Cursor upstream FALLBACK_MODELS in synced reference");
  }

  const bodyStart = source.indexOf("[", start);
  let depth = 0;
  let bodyEnd = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = index;
        break;
      }
    }
  }

  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error("Unable to parse Cursor upstream FALLBACK_MODELS in synced reference");
  }

  return [...source.slice(bodyStart, bodyEnd + 1).matchAll(/\bid\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]!)
    .sort((a, b) => a.localeCompare(b));
}

describe("resolvePricingKey snapshot coverage", () => {
  it("resolves every models.dev provider/model pair when source ids are official", () => {
    const failures: string[] = [];
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);

    outer: for (const providerID of providers) {
      const modelIDs = listModelsForProvider(providerID);
      for (const modelID of modelIDs) {
        const resolved = resolvePricingKey({ providerID, modelID });
        if (!resolved.ok) {
          failures.push(`${providerID}/${modelID} -> unresolved`);
        } else if (resolved.key.provider !== providerID || resolved.key.model !== modelID) {
          failures.push(
            `${providerID}/${modelID} -> ${resolved.key.provider}/${resolved.key.model} (${resolved.method})`,
          );
        }
        if (failures.length >= 10) break outer;
      }
    }

    expect(failures).toEqual([]);
  });

  it("resolves provider/model prefixes even when source provider id is unknown", () => {
    const providers = listProviders();
    const providerID = providers[0];
    expect(providerID).toBeTruthy();

    const modelID = listModelsForProvider(providerID!)[0];
    expect(modelID).toBeTruthy();

    const resolved = resolvePricingKey({
      providerID: "connector-without-pricing-id",
      modelID: `${providerID}/${modelID}`,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.key.provider).toBe(providerID);
    expect(resolved.key.model).toBe(modelID);
  });

  it("maps copilot and proxy model variants to priced snapshot keys", () => {
    const copilotHaiku = resolvePricingKey({
      providerID: "github-copilot",
      modelID: "github-copilot/claude-haiku-4.5",
    });
    expect(copilotHaiku.ok).toBe(true);
    if (!copilotHaiku.ok) return;
    expect(copilotHaiku.key).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });

    const copilotGrok = resolvePricingKey({
      providerID: "github-copilot",
      modelID: "github-copilot/grok-code-fast-1",
    });
    expect(copilotGrok.ok).toBe(true);
    if (!copilotGrok.ok) return;
    expect(copilotGrok.key).toEqual({ provider: "xai", model: "grok-code-fast-1" });

    const kimiBase = resolvePricingKey({
      providerID: "CLIProxyAPI",
      modelID: "moonshotai/kimi-k2.5",
    });
    expect(kimiBase.ok).toBe(true);
    if (!kimiBase.ok) return;
    expect(kimiBase.key).toEqual({ provider: "moonshotai", model: "kimi-k2.5" });

    const kimiFree = resolvePricingKey({
      providerID: "opencode",
      modelID: "opencode/kimi-k2.5-free",
    });
    expect(kimiFree.ok).toBe(true);
    if (!kimiFree.ok) return;
    expect(kimiFree.key).toEqual({ provider: "moonshotai", model: "kimi-k2.5" });

    const openaiFreeKnownProvider = resolvePricingKey({
      providerID: "openai",
      modelID: "openai/gpt-4o-mini-free",
    });
    expect(openaiFreeKnownProvider.ok).toBe(true);
    if (!openaiFreeKnownProvider.ok) return;
    expect(openaiFreeKnownProvider.key).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    const openaiFreeModelPrefix = resolvePricingKey({
      providerID: "connector-without-pricing-id",
      modelID: "openai/gpt-4o-mini-free",
    });
    expect(openaiFreeModelPrefix.ok).toBe(true);
    if (!openaiFreeModelPrefix.ok) return;
    expect(openaiFreeModelPrefix.key).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    expect(lookupCost("anthropic", "claude-haiku-4-5")).not.toBeNull();
    expect(lookupCost("xai", "grok-code-fast-1")).not.toBeNull();
    expect(lookupCost("moonshotai", "kimi-k2.5")).not.toBeNull();
    expect(lookupCost("openai", "gpt-4o-mini")).not.toBeNull();
  });

  it("maps cursor local and api-pool models into deterministic pricing keys", () => {
    const auto = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/auto",
    });
    expect(auto.ok).toBe(true);
    if (!auto.ok) return;
    expect(auto.key).toEqual({ provider: "cursor", model: "auto" });

    const autoBare = resolvePricingKey({
      providerID: "cursor",
      modelID: "auto",
    });
    expect(autoBare.ok).toBe(true);
    if (!autoBare.ok) return;
    expect(autoBare.key).toEqual({ provider: "cursor", model: "auto" });

    const autoDefault = resolvePricingKey({
      providerID: "cursor",
      modelID: "default[]",
    });
    expect(autoDefault.ok).toBe(true);
    if (!autoDefault.ok) return;
    expect(autoDefault.key).toEqual({ provider: "cursor", model: "auto" });

    const legacyAuto = resolvePricingKey({
      providerID: "cursor-acp",
      modelID: "cursor-acp/auto",
    });
    expect(legacyAuto.ok).toBe(true);
    if (!legacyAuto.ok) return;
    expect(legacyAuto.key).toEqual({ provider: "cursor", model: "auto" });

    const composer1 = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/composer-1",
    });
    expect(composer1.ok).toBe(true);
    if (!composer1.ok) return;
    expect(composer1.key).toEqual({ provider: "cursor", model: "composer-1" });

    const composer15 = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/composer-1.5",
    });
    expect(composer15.ok).toBe(true);
    if (!composer15.ok) return;
    expect(composer15.key).toEqual({ provider: "cursor", model: "composer-1.5" });

    const composer2 = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/composer-2",
    });
    expect(composer2.ok).toBe(true);
    if (!composer2.ok) return;
    expect(composer2.key).toEqual({ provider: "cursor", model: "composer-2" });

    const composer2Fast = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/composer-2-fast",
    });
    expect(composer2Fast.ok).toBe(true);
    if (!composer2Fast.ok) return;
    expect(composer2Fast.key).toEqual({ provider: "cursor", model: "composer-2-fast" });

    for (const unsupportedModelID of [
      "cursor/composer",
      "cursor/composer-fast",
      "cursor/composer-2fast",
      "cursor/composer-2-fast-thinking",
      "cursor/composer-3",
    ]) {
      expect(
        resolvePricingKey({
          providerID: "cursor",
          modelID: unsupportedModelID,
        }).ok,
      ).toBe(false);
    }

    const gpt = resolvePricingKey({
      providerID: "cursor",
      modelID: "gpt-5.4-high",
    });
    expect(gpt.ok).toBe(true);
    if (!gpt.ok) return;
    expect(gpt.key).toEqual({ provider: "openai", model: "gpt-5.4" });

    const anthropic = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/sonnet-4.6-thinking",
    });
    expect(anthropic.ok).toBe(true);
    if (!anthropic.ok) return;
    expect(anthropic.key).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });

    const discoveredAnthropicIds = [
      ["cursor/claude-4.5-sonnet", { provider: "anthropic", model: "claude-sonnet-4-5" }],
      ["cursor/claude-4.6-opus", { provider: "anthropic", model: "claude-opus-4-6" }],
      ["cursor/claude-4.6-sonnet", { provider: "anthropic", model: "claude-sonnet-4-6" }],
    ] as const;

    for (const [modelID, key] of discoveredAnthropicIds) {
      const resolved = resolvePricingKey({
        providerID: "cursor",
        modelID,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.key).toEqual(key);
    }
  });

  it("keeps cursor local pricing buckets distinct", () => {
    expect(lookupCursorLocalCost("auto")).toEqual({
      input: 1.25,
      cache_read: 0.25,
      output: 6,
    });
    expect(lookupCursorLocalCost("composer-1")).toEqual({
      input: 1.25,
      cache_read: 0.125,
      output: 10,
    });
    expect(lookupCursorLocalCost("composer-1.5")).toEqual({
      input: 3.5,
      cache_read: 0.35,
      output: 17.5,
    });
    expect(lookupCursorLocalCost("composer-2")).toEqual({
      input: 0.5,
      cache_read: 0.2,
      output: 2.5,
    });
    expect(lookupCursorLocalCost("composer-2-fast")).toEqual({
      input: 1.5,
      cache_read: 0.35,
      output: 7.5,
    });
  });

  it("keeps every Cursor API alias aligned with a priced snapshot key", () => {
    const failures: string[] = [];

    for (const alias of Object.keys(CURSOR_OFFICIAL_MODEL_ALIASES).sort()) {
      const target = CURSOR_OFFICIAL_MODEL_ALIASES[alias];
      if (!target || target.providerHint === "cursor") continue;

      const resolved = resolvePricingKey({
        providerID: "cursor",
        modelID: `cursor/${alias}`,
      });

      if (!resolved.ok) {
        failures.push(`${alias} -> unresolved`);
        continue;
      }

      if (resolved.method !== "cursor_api_alias") {
        failures.push(`${alias} -> unexpected method ${resolved.method}`);
        continue;
      }

      if (
        resolved.key.provider !== target.providerHint ||
        resolved.key.model !== target.modelHint
      ) {
        failures.push(
          `${alias} -> ${resolved.key.provider}/${resolved.key.model} (expected ${target.providerHint}/${target.modelHint})`,
        );
        continue;
      }

      if (!lookupCost(resolved.key.provider, resolved.key.model)) {
        failures.push(`${alias} -> missing priced snapshot key ${resolved.key.provider}/${resolved.key.model}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("accounts for every synced upstream Cursor fallback model id", () => {
    const fallbackModelIds = getCursorUpstreamFallbackModelIds();
    const intentionallyUnknown = [...CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS].sort((a, b) =>
      a.localeCompare(b),
    );

    expect(
      intentionallyUnknown.filter((modelID) => !fallbackModelIds.includes(modelID)),
      "Remove stale entries from CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS when upstream fallback ids change.",
    ).toEqual([]);

    const failures: string[] = [];

    for (const modelID of fallbackModelIds) {
      const resolvedModel = resolveCursorModel(`cursor/${modelID}`);
      const resolvedPricing = resolvePricingKey({
        providerID: "cursor",
        modelID: `cursor/${modelID}`,
      });

      if (resolvedModel.kind === "unknown") {
        if (!CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS.has(modelID)) {
          failures.push(`${modelID} -> resolveCursorModel() returned unknown`);
        }
        continue;
      }

      if (CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS.has(modelID)) {
        failures.push(`${modelID} -> resolved but still allowlisted as intentionally unknown`);
        continue;
      }

      if (resolvedModel.kind === "local") {
        if (!lookupCursorLocalCost(resolvedModel.model)) {
          failures.push(`${modelID} -> missing local Cursor pricing bucket`);
        }
        if (!resolvedPricing.ok) {
          failures.push(`${modelID} -> resolvePricingKey() was unresolved`);
        }
        continue;
      }

      const cost = lookupCost(resolvedModel.providerHint, resolvedModel.modelHint);
      if (!cost) {
        failures.push(
          `${modelID} -> missing priced snapshot key ${resolvedModel.providerHint}/${resolvedModel.modelHint}`,
        );
        continue;
      }

      if (!resolvedPricing.ok) {
        failures.push(`${modelID} -> resolvePricingKey() was unresolved`);
        continue;
      }

      if (resolvedPricing.method !== "cursor_api_alias") {
        failures.push(`${modelID} -> unexpected resolvePricingKey() method ${resolvedPricing.method}`);
        continue;
      }

      if (
        resolvedPricing.key.provider !== resolvedModel.providerHint ||
        resolvedPricing.key.model !== resolvedModel.modelHint
      ) {
        failures.push(
          `${modelID} -> ${resolvedPricing.key.provider}/${resolvedPricing.key.model} (expected ${resolvedModel.providerHint}/${resolvedModel.modelHint})`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
