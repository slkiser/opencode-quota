import type { OpenCodeMessage } from "./opencode-storage.js";
import {
  iterAssistantMessages,
  iterAssistantMessagesForSession,
  readAllSessionsIndex,
  SessionNotFoundError,
} from "./opencode-storage.js";
import { lookupCost } from "./modelsdev-pricing.js";

// Re-export for consumers
export { SessionNotFoundError } from "./opencode-storage.js";

export type TokenBuckets = {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
};

export type PricedKey = {
  provider: string;
  model: string;
};

export type UnknownKey = {
  sourceProviderID: string;
  sourceModelID: string;
  mappedProvider?: string;
  mappedModel?: string;
};

export type AggregateRow = {
  key: PricedKey;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
};

export type SessionRow = {
  sessionID: string;
  title?: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
};

export type SourceProviderRow = {
  providerID: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
};

export type SourceModelRow = {
  sourceProviderID: string;
  sourceModelID: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
};

export type UnknownRow = {
  key: UnknownKey;
  tokens: TokenBuckets;
  messageCount: number;
};

export type AggregateResult = {
  window: { sinceMs?: number; untilMs?: number };
  totals: {
    priced: TokenBuckets;
    unknown: TokenBuckets;
    costUsd: number;
    messageCount: number;
    sessionCount: number;
  };
  bySourceProvider: SourceProviderRow[];
  bySourceModel: SourceModelRow[];
  byModel: AggregateRow[];
  bySession: SessionRow[];
  unknown: UnknownRow[];
};

function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
}

function addBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
  };
}

function messageBuckets(msg: OpenCodeMessage): TokenBuckets {
  const t = msg.tokens;
  if (!t) return emptyBuckets();
  return {
    input: typeof t.input === "number" ? t.input : 0,
    output: typeof t.output === "number" ? t.output : 0,
    reasoning: typeof t.reasoning === "number" ? t.reasoning : 0,
    cache_read: typeof t.cache?.read === "number" ? t.cache.read : 0,
    cache_write: typeof t.cache?.write === "number" ? t.cache.write : 0,
  };
}

function normalizeModelId(raw: string): string {
  let s = raw.trim();
  // routing prefixes
  if (s.toLowerCase().startsWith("antigravity-")) s = s.slice("antigravity-".length);
  // common subscription variants
  if (s.toLowerCase().endsWith("-thinking")) s = s.slice(0, -"-thinking".length);
  // claude 4.5 -> 4-5 (models.dev uses dash)
  s = s.replace(/claude-([a-z-]+)-4\.5\b/i, "claude-$1-4-5");
  // special: "glm-4.7-free" -> "glm-4.7"
  s = s.replace(/\bglm-(\d+)\.(\d+)-free\b/i, "glm-$1.$2");
  // internal OpenCode alias (Zen)
  if (s.toLowerCase() === "big-pickle") s = "glm-4.7";
  return s;
}

function inferOfficialProviderFromModelId(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o")) return "openai";
  if (lower.startsWith("gemini")) return "google";
  if (lower.startsWith("kimi")) return "moonshotai";
  if (lower.startsWith("glm")) return "zai";
  // heuristics
  if (lower.includes("claude")) return "anthropic";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("gpt")) return "openai";
  if (lower.includes("kimi")) return "moonshotai";
  if (lower.includes("glm")) return "zai";
  return null;
}

function mapToOfficialPricingKey(source: {
  providerID?: string;
  modelID?: string;
}): { ok: true; key: PricedKey } | { ok: false; unknown: UnknownKey } {
  const srcProvider = source.providerID ?? "unknown";
  const srcModel = source.modelID ?? "unknown";

  if (!source.modelID || typeof source.modelID !== "string") {
    return { ok: false, unknown: { sourceProviderID: srcProvider, sourceModelID: srcModel } };
  }

  const normalizedModel = normalizeModelId(source.modelID);
  const inferredProvider = inferOfficialProviderFromModelId(normalizedModel);
  if (!inferredProvider) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedProvider: undefined,
        mappedModel: normalizedModel,
      },
    };
  }

  // Kimi naming: some logs use kimi-k2-thinking, but models.dev doesn't have kimi-k2.
  // Treat kimi-k2 as kimi-k2-thinking for pricing.
  if (inferredProvider === "moonshotai") {
    if (normalizedModel === "kimi-k2") {
      if (lookupCost("moonshotai", "kimi-k2-thinking")) {
        return { ok: true, key: { provider: "moonshotai", model: "kimi-k2-thinking" } };
      }
    }
  }

  // Gemini naming fallback: some logs omit -preview
  if (inferredProvider === "google") {
    if (normalizedModel === "gemini-3-pro" && lookupCost("google", "gemini-3-pro") == null) {
      if (lookupCost("google", "gemini-3-pro-preview")) {
        return { ok: true, key: { provider: "google", model: "gemini-3-pro-preview" } };
      }
    }
    if (normalizedModel === "gemini-3-flash" && lookupCost("google", "gemini-3-flash") == null) {
      if (lookupCost("google", "gemini-3-flash-preview")) {
        return { ok: true, key: { provider: "google", model: "gemini-3-flash-preview" } };
      }
    }
  }

  return { ok: true, key: { provider: inferredProvider, model: normalizedModel } };
}

function calculateCostUsd(params: {
  provider: string;
  model: string;
  tokens: TokenBuckets;
}): { ok: true; costUsd: number } | { ok: false } {
  const cost = lookupCost(params.provider, params.model);
  if (!cost) return { ok: false };

  // models.dev costs are USD per 1M tokens
  const perToken = (usdPer1M?: number) => (typeof usdPer1M === "number" ? usdPer1M / 1_000_000 : 0);
  const inRate = perToken(cost.input);
  const outRate = perToken(cost.output);
  const cacheReadRate = perToken(cost.cache_read ?? cost.input);
  const cacheWriteRate = perToken(cost.cache_write ?? cost.input);
  const reasoningRate = perToken(cost.reasoning ?? cost.output);

  const usd =
    params.tokens.input * inRate +
    params.tokens.output * outRate +
    params.tokens.cache_read * cacheReadRate +
    params.tokens.cache_write * cacheWriteRate +
    params.tokens.reasoning * reasoningRate;

  return { ok: true, costUsd: usd };
}

export async function aggregateUsage(params: {
  sinceMs?: number;
  untilMs?: number;
  sessionID?: string;
}): Promise<AggregateResult> {
  // Use session-scoped iterator when filtering by sessionID for better performance
  let messages: OpenCodeMessage[];
  if (params.sessionID) {
    messages = await iterAssistantMessagesForSession({
      sessionID: params.sessionID,
      sinceMs: params.sinceMs,
      untilMs: params.untilMs,
    });
  } else {
    messages = await iterAssistantMessages({ sinceMs: params.sinceMs, untilMs: params.untilMs });
  }
  const sessionsIdx = await readAllSessionsIndex();

  const byModel = new Map<string, AggregateRow>();
  const bySession = new Map<string, SessionRow>();
  const bySourceProvider = new Map<string, SourceProviderRow>();
  const bySourceModel = new Map<string, SourceModelRow>();
  const unknown = new Map<string, UnknownRow>();

  let pricedTotals = emptyBuckets();
  let unknownTotals = emptyBuckets();
  let costTotal = 0;

  for (const msg of messages) {
    const tokens = messageBuckets(msg);
    const mapping = mapToOfficialPricingKey({ providerID: msg.providerID, modelID: msg.modelID });

    if (!mapping.ok) {
      unknownTotals = addBuckets(unknownTotals, tokens);
      const k = JSON.stringify(mapping.unknown);
      const row = unknown.get(k);
      if (row) {
        row.tokens = addBuckets(row.tokens, tokens);
        row.messageCount += 1;
      } else {
        unknown.set(k, { key: mapping.unknown, tokens, messageCount: 1 });
      }
      continue;
    }

    const priced = calculateCostUsd({
      provider: mapping.key.provider,
      model: mapping.key.model,
      tokens,
    });
    if (!priced.ok) {
      // Mapping succeeded but pricing missing.
      unknownTotals = addBuckets(unknownTotals, tokens);
      const unk: UnknownKey = {
        sourceProviderID: msg.providerID ?? "unknown",
        sourceModelID: msg.modelID ?? "unknown",
        mappedProvider: mapping.key.provider,
        mappedModel: mapping.key.model,
      };
      const k = JSON.stringify(unk);
      const row = unknown.get(k);
      if (row) {
        row.tokens = addBuckets(row.tokens, tokens);
        row.messageCount += 1;
      } else {
        unknown.set(k, { key: unk, tokens, messageCount: 1 });
      }
      continue;
    }

    pricedTotals = addBuckets(pricedTotals, tokens);
    costTotal += priced.costUsd;

    // Tokscale-style: key by OpenCode source provider + source model id.
    const srcProviderID = msg.providerID ?? "unknown";
    const srcModelID = msg.modelID ?? "unknown";
    const srcModelKey = `${srcProviderID}\n${srcModelID}`;
    const sm = bySourceModel.get(srcModelKey);
    if (sm) {
      sm.tokens = addBuckets(sm.tokens, tokens);
      sm.costUsd += priced.costUsd;
      sm.messageCount += 1;
    } else {
      bySourceModel.set(srcModelKey, {
        sourceProviderID: srcProviderID,
        sourceModelID: srcModelID,
        tokens,
        costUsd: priced.costUsd,
        messageCount: 1,
      });
    }

    const srcProvider = srcProviderID;
    const src = bySourceProvider.get(srcProvider);
    if (src) {
      src.tokens = addBuckets(src.tokens, tokens);
      src.costUsd += priced.costUsd;
      src.messageCount += 1;
    } else {
      bySourceProvider.set(srcProvider, {
        providerID: srcProvider,
        tokens,
        costUsd: priced.costUsd,
        messageCount: 1,
      });
    }

    const modelKey = `${mapping.key.provider}/${mapping.key.model}`;
    const existing = byModel.get(modelKey);
    if (existing) {
      existing.tokens = addBuckets(existing.tokens, tokens);
      existing.costUsd += priced.costUsd;
      existing.messageCount += 1;
    } else {
      byModel.set(modelKey, {
        key: mapping.key,
        tokens,
        costUsd: priced.costUsd,
        messageCount: 1,
      });
    }

    const sid = msg.sessionID;
    const s = bySession.get(sid);
    const title = sessionsIdx[sid]?.title;
    if (s) {
      s.tokens = addBuckets(s.tokens, tokens);
      s.costUsd += priced.costUsd;
      s.messageCount += 1;
    } else {
      bySession.set(sid, {
        sessionID: sid,
        title,
        tokens,
        costUsd: priced.costUsd,
        messageCount: 1,
      });
    }
  }

  const byModelRows = Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd);
  const bySessionRows = Array.from(bySession.values()).sort((a, b) => b.costUsd - a.costUsd);
  const bySourceProviderRows = Array.from(bySourceProvider.values()).sort(
    (a, b) => b.costUsd - a.costUsd,
  );
  const bySourceModelRows = Array.from(bySourceModel.values()).sort(
    (a, b) => b.costUsd - a.costUsd,
  );
  const unknownRows = Array.from(unknown.values()).sort(
    (a, b) =>
      b.tokens.input +
      b.tokens.output +
      b.tokens.reasoning +
      b.tokens.cache_read +
      b.tokens.cache_write -
      (a.tokens.input +
        a.tokens.output +
        a.tokens.reasoning +
        a.tokens.cache_read +
        a.tokens.cache_write),
  );

  return {
    window: { sinceMs: params.sinceMs, untilMs: params.untilMs },
    totals: {
      priced: pricedTotals,
      unknown: unknownTotals,
      costUsd: costTotal,
      messageCount: messages.length,
      sessionCount: new Set(messages.map((m) => m.sessionID)).size,
    },
    bySourceProvider: bySourceProviderRows,
    bySourceModel: bySourceModelRows,
    byModel: byModelRows,
    bySession: bySessionRows,
    unknown: unknownRows,
  };
}

/**
 * Lightweight session token summary for toast display.
 * Returns per-model input/output totals for a single session.
 */
export type SessionTokenRow = {
  modelID: string;
  input: number;
  output: number;
};

export type SessionTokenSummary = {
  sessionID: string;
  models: SessionTokenRow[];
  totalInput: number;
  totalOutput: number;
};

export async function getSessionTokenSummary(
  sessionID: string,
): Promise<SessionTokenSummary | null> {
  // Use session-scoped iterator for better performance (only reads this session's directory)
  const sessionMessages = await iterAssistantMessagesForSession({ sessionID });

  if (sessionMessages.length === 0) return null;

  const byModel = new Map<string, { input: number; output: number }>();
  let totalInput = 0;
  let totalOutput = 0;

  for (const msg of sessionMessages) {
    const tokens = msg.tokens;
    if (!tokens) continue;

    const input = typeof tokens.input === "number" ? tokens.input : 0;
    const output = typeof tokens.output === "number" ? tokens.output : 0;

    // Skip if both are 0
    if (input === 0 && output === 0) continue;

    totalInput += input;
    totalOutput += output;

    const modelID = msg.modelID ?? "unknown";
    const existing = byModel.get(modelID);
    if (existing) {
      existing.input += input;
      existing.output += output;
    } else {
      byModel.set(modelID, { input, output });
    }
  }

  // Sort by total tokens descending
  const models = Array.from(byModel.entries())
    .map(([modelID, t]) => ({ modelID, input: t.input, output: t.output }))
    .filter((m) => m.input > 0 || m.output > 0)
    .sort((a, b) => b.input + b.output - (a.input + a.output));

  return {
    sessionID,
    models,
    totalInput,
    totalOutput,
  };
}
