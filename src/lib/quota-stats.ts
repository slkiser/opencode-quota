import type { OpenCodeMessage } from "./opencode-storage.js";
import {
  getOpenCodeDbPath,
  iterAssistantMessages,
  iterAssistantMessagesForSessions,
  iterAssistantMessagesForSession,
  readAllSessionsIndex,
  SessionNotFoundError,
} from "./opencode-storage.js";
import {
  hasCost,
  hasProvider,
  hasModel,
  isModelsDevProviderId,
  listProvidersForModelId,
  lookupCost,
} from "./modelsdev-pricing.js";
import {
  isCursorModelId,
  isCursorProviderId,
  lookupCursorLocalCost,
  resolveCursorModel,
} from "./cursor-pricing.js";
import { calculateUsdFromTokenBuckets } from "./token-cost.js";
import {
  addTokenBuckets,
  emptyTokenBuckets,
  tokenBucketsFromMessage,
} from "./token-buckets.js";
import type { TokenBuckets } from "./token-buckets.js";

// Re-export for consumers
export { SessionNotFoundError } from "./opencode-storage.js";
export type { TokenBuckets } from "./token-buckets.js";

export type PricedKey = {
  provider: string;
  model: string;
};

export type UnknownKey = {
  sourceProviderID: string;
  sourceModelID: string;
  mappedProvider?: string;
  mappedModel?: string;
  normalizedModelID?: string;
  providerCandidates?: string[];
  reason?: "missing_model" | "missing_provider" | "ambiguous_model";
};

export type PricingResolution =
  | {
      ok: true;
      key: PricedKey;
      method:
        | "source_provider"
        | "model_prefix"
        | "unique_model"
        | "alias_fallback"
        | "cursor_local"
        | "cursor_api_alias";
    }
  | { ok: false; unknown: UnknownKey };

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

export type UnpricedKey = {
  sourceProviderID: string;
  sourceModelID: string;
  mappedProvider: string;
  mappedModel: string;
  reason: string;
};

export type UnpricedRow = {
  key: UnpricedKey;
  tokens: TokenBuckets;
  messageCount: number;
};

export type SessionTreeNode = {
  sessionID: string;
  parentID?: string;
  title?: string;
  depth: number;
};

export type AggregateResult = {
  window: { sinceMs?: number; untilMs?: number };
  totals: {
    priced: TokenBuckets;
    unknown: TokenBuckets;
    unpriced: TokenBuckets;
    costUsd: number;
    messageCount: number;
    sessionCount: number;
  };
  bySourceProvider: SourceProviderRow[];
  bySourceModel: SourceModelRow[];
  byModel: AggregateRow[];
  bySession: SessionRow[];
  unknown: UnknownRow[];
  unpriced: UnpricedRow[];
};

function normalizeModelId(raw: string): string {
  let s = raw.trim();

  // routing prefixes
  if (s.toLowerCase().startsWith("antigravity-")) s = s.slice("antigravity-".length);
  // claude dotted versions -> hyphenated (models.dev uses dash): 4.5 -> 4-5, 4.6 -> 4-6, etc.
  s = s.replace(/(claude-[a-z-]+)-(\d+)\.(\d+)(?=$|[^0-9])/gi, "$1-$2-$3");
  // special: "glm-4.7-free" -> "glm-4.7"
  s = s.replace(/\bglm-(\d+)\.(\d+)-free\b/i, "glm-$1.$2");
  // internal OpenCode alias (Zen)
  if (s.toLowerCase() === "big-pickle") s = "glm-4.7";
  return s;
}

function stripFreeSuffix(modelId: string): string | null {
  if (!modelId.toLowerCase().endsWith("-free")) return null;
  const stripped = modelId.slice(0, -"-free".length);
  return stripped || null;
}

function freeSuffixCandidates(modelId: string): string[] {
  const candidates = [modelId];
  const stripped = stripFreeSuffix(modelId);
  if (stripped) candidates.push(stripped);
  return candidates.filter((value, index, list) => list.indexOf(value) === index);
}

function pickBestModelForProvider(providerID: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (hasCost(providerID, candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (hasModel(providerID, candidate)) return candidate;
  }
  return null;
}

function parseModelIdHint(rawModelId?: string): { providerHint?: string; modelPart?: string } {
  if (!rawModelId || typeof rawModelId !== "string") return {};
  const trimmed = rawModelId.trim();
  if (!trimmed) return {};
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) return { modelPart: trimmed };
  if (lastSlash === trimmed.length - 1) return { providerHint: trimmed.slice(0, -1) };
  return { providerHint: trimmed.slice(0, lastSlash), modelPart: trimmed.slice(lastSlash + 1) };
}

const SOURCE_PROVIDER_ALIASES: Record<string, string> = {
  cursor: "cursor",
  "cursor-acp": "cursor",
  "github-copilot": "openai",
  "copilot-chat": "openai",
  chatgpt: "openai",
  codex: "openai",
  "zai-coding-plan": "zai",
  glm: "zai",
};

function normalizeSourceProviderId(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const lowered = raw.trim().toLowerCase();
  if (!lowered || lowered === "unknown") return undefined;

  const parts = lowered.split(/[/:]/g).filter(Boolean);
  const candidates = [lowered, ...parts].filter((v, i, arr) => arr.indexOf(v) === i);

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    if (isModelsDevProviderId(candidate)) return candidate;
    const alias = SOURCE_PROVIDER_ALIASES[candidate];
    if (alias && isModelsDevProviderId(alias)) return alias;
  }

  const directAlias = SOURCE_PROVIDER_ALIASES[lowered];
  return directAlias ?? lowered;
}

function inferOfficialProviderFromModelId(modelId: string): string | null {
  // Prefer snapshot-driven inference when possible.
  // This keeps mapping future-proof as models.dev adds providers/models.
  const providers = listProvidersForModelId(modelId);
  if (providers.length === 1) return providers[0] ?? null;

  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o")) return "openai";
  if (lower.startsWith("gemini")) return "google";
  if (lower.startsWith("kimi")) return "moonshotai";
  if (lower.startsWith("glm")) return "zai";
  if (lower.startsWith("grok")) return "xai";
  // heuristics
  if (lower.includes("claude")) return "anthropic";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("gpt")) return "openai";
  if (lower.includes("kimi")) return "moonshotai";
  if (lower.includes("glm")) return "zai";
  if (lower.includes("grok")) return "xai";
  return null;
}

/**
 * Get pricing alias candidates for Anthropic models when the exact key is missing.
 * Returns ordered candidates to try, including the original model.
 */
function anthropicPricingCandidates(model: string): string[] {
  // model is expected normalized like "claude-opus-4-6"
  if (model === "claude-opus-4-6") return [model, "claude-opus-4-5"];
  if (model === "claude-sonnet-4-6") return [model, "claude-sonnet-4-7", "claude-sonnet-4-5"];
  // Future-proof: try next lower version for any claude-*-N-M pattern
  const match = model.match(/^(claude-[a-z]+-\d+)-(\d+)$/);
  if (match) {
    const [, prefix, minor] = match;
    const minorNum = parseInt(minor, 10);
    if (minorNum > 0) {
      return [model, `${prefix}-${minorNum - 1}`];
    }
  }
  return [model];
}

function moonshotaiPricingCandidates(model: string): string[] {
  const candidates: string[] = [];
  for (const freeCandidate of freeSuffixCandidates(model)) {
    candidates.push(freeCandidate);
    if (freeCandidate.includes(".")) {
      candidates.push(freeCandidate.replace(/\./g, "-"));
    }
  }
  return candidates.filter((value, index, list) => list.indexOf(value) === index);
}

function resolveModelForProvider(providerID: string, normalizedModel: string): string | null {
  if (!isModelsDevProviderId(providerID)) return null;
  const preferredDirect = pickBestModelForProvider(providerID, freeSuffixCandidates(normalizedModel));
  if (preferredDirect) return preferredDirect;

  // Some source ids include "-thinking" while snapshot keeps a base key (or vice versa).
  if (normalizedModel.toLowerCase().endsWith("-thinking")) {
    const withoutThinking = normalizedModel.slice(0, -"-thinking".length);
    if (hasModel(providerID, withoutThinking)) return withoutThinking;
  }

  // Kimi naming: some logs use kimi-k2, while snapshot may use kimi-k2-thinking.
  if (providerID === "moonshotai" && normalizedModel === "kimi-k2") {
    if (hasModel("moonshotai", "kimi-k2-thinking")) return "kimi-k2-thinking";
  }

  if (providerID === "moonshotai") {
    const preferredMoonshot = pickBestModelForProvider(
      "moonshotai",
      moonshotaiPricingCandidates(normalizedModel),
    );
    if (preferredMoonshot) return preferredMoonshot;
  }

  // Gemini naming fallback: some logs omit -preview.
  if (providerID === "google") {
    if (normalizedModel === "gemini-3-pro" && hasModel("google", "gemini-3-pro-preview")) {
      return "gemini-3-pro-preview";
    }
    if (normalizedModel === "gemini-3-flash" && hasModel("google", "gemini-3-flash-preview")) {
      return "gemini-3-flash-preview";
    }
  }

  // Anthropic alias fallback: try alternative version keys when exact key is missing.
  if (providerID === "anthropic") {
    const candidates = anthropicPricingCandidates(normalizedModel);
    for (const candidate of candidates) {
      if (hasModel("anthropic", candidate)) return candidate;
    }
  }

  return null;
}

export function resolvePricingKey(source: {
  providerID?: string;
  modelID?: string;
}): PricingResolution {
  const srcProvider = source.providerID ?? "unknown";
  const srcModel = source.modelID ?? "unknown";

  if (!source.modelID || typeof source.modelID !== "string") {
    return {
      ok: false,
      unknown: { sourceProviderID: srcProvider, sourceModelID: srcModel, reason: "missing_model" },
    };
  }

  const parsed = parseModelIdHint(source.modelID);
  if (!parsed.modelPart) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        reason: "missing_model",
      },
    };
  }

  const normalizedModel = normalizeModelId(parsed.modelPart);
  const sourceProviderHint = normalizeSourceProviderId(source.providerID);
  const modelProviderHint = normalizeSourceProviderId(parsed.providerHint);

  const tryProvider = (
    providerID: string | undefined,
    method:
      | "source_provider"
      | "model_prefix"
      | "alias_fallback"
      | "cursor_api_alias",
    modelIDHint: string = normalizedModel,
  ): PricingResolution | null => {
    if (!providerID) return null;
    const modelID = resolveModelForProvider(providerID, modelIDHint);
    if (!modelID) return null;
    return { ok: true, key: { provider: providerID, model: modelID }, method };
  };

  if (isCursorProviderId(source.providerID) || isCursorModelId(source.modelID)) {
    const cursorModel = resolveCursorModel(source.modelID);
    if (cursorModel.kind === "local") {
      return {
        ok: true,
        key: { provider: "cursor", model: cursorModel.model },
        method: "cursor_local",
      };
    }
    if (cursorModel.kind === "official") {
      const resolved = tryProvider(
        cursorModel.providerHint,
        "cursor_api_alias",
        cursorModel.modelHint,
      );
      if (resolved) return resolved;
    }
  }

  const fromSourceProvider = tryProvider(sourceProviderHint, "source_provider");
  if (fromSourceProvider) return fromSourceProvider;

  const fromModelPrefix = tryProvider(modelProviderHint, "model_prefix");
  if (fromModelPrefix) return fromModelPrefix;

  const modelCandidates = freeSuffixCandidates(normalizedModel);
  let ambiguousMatch: { model: string; providerCandidates: string[] } | null = null;

  for (const candidateModel of modelCandidates) {
    const providerCandidates = listProvidersForModelId(candidateModel);
    if (providerCandidates.length === 1) {
      const provider = providerCandidates[0]!;
      return {
        ok: true,
        key: { provider, model: candidateModel },
        method: "unique_model",
      };
    }

    if (providerCandidates.length > 1) {
      const inferredAmbiguousProvider = inferOfficialProviderFromModelId(candidateModel);
      if (inferredAmbiguousProvider && providerCandidates.includes(inferredAmbiguousProvider)) {
        const inferredFromAmbiguous = tryProvider(
          inferredAmbiguousProvider,
          "alias_fallback",
          candidateModel,
        );
        if (inferredFromAmbiguous) return inferredFromAmbiguous;
      }

      if (!ambiguousMatch) {
        ambiguousMatch = {
          model: candidateModel,
          providerCandidates: [...providerCandidates].sort((a, b) => a.localeCompare(b)),
        };
      }
    }
  }

  if (ambiguousMatch) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedModel: ambiguousMatch.model,
        normalizedModelID: ambiguousMatch.model,
        providerCandidates: ambiguousMatch.providerCandidates,
        reason: "ambiguous_model",
      },
    };
  }

  let inferredMissing: { provider: string; model: string } | null = null;
  for (const candidateModel of modelCandidates) {
    const inferredProvider = inferOfficialProviderFromModelId(candidateModel);
    const inferred = tryProvider(inferredProvider ?? undefined, "alias_fallback", candidateModel);
    if (inferred) return inferred;

    if (inferredProvider && !inferredMissing) {
      inferredMissing = { provider: inferredProvider, model: candidateModel };
    }
  }

  if (inferredMissing) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedProvider: inferredMissing.provider,
        mappedModel: inferredMissing.model,
        normalizedModelID: inferredMissing.model,
        reason: "missing_provider",
      },
    };
  }

  return {
    ok: false,
    unknown: {
      sourceProviderID: srcProvider,
      sourceModelID: srcModel,
      mappedModel: normalizedModel,
      normalizedModelID: normalizedModel,
      reason: "missing_provider",
    },
  };
}

function calculateCostUsd(params: {
  provider: string;
  model: string;
  tokens: TokenBuckets;
}): { ok: true; costUsd: number } | { ok: false } {
  const cost =
    params.provider === "cursor"
      ? lookupCursorLocalCost(params.model)
      : lookupCost(params.provider, params.model);
  if (!cost) return { ok: false };
  return { ok: true, costUsd: calculateUsdFromTokenBuckets(cost, params.tokens) };
}

function classifyMissingPricing(params: {
  mappedProvider: string;
  mappedModel: string;
}): { kind: "unpriced"; reason: string } | { kind: "unknown" } {
  if (params.mappedProvider === "cursor") {
    return { kind: "unknown" };
  }

  // Defensive: if provider wasn't in snapshot we should treat this as unknown mapping.
  if (!hasProvider(params.mappedProvider)) {
    return { kind: "unknown" };
  }

  // When provider/model exists in snapshot but has no numeric rates, classify as unpriced.
  if (hasModel(params.mappedProvider, params.mappedModel)) {
    if (params.mappedModel.toLowerCase().endsWith("-free")) {
      return { kind: "unpriced", reason: "free-tier model id not priced in snapshot" };
    }
    return { kind: "unpriced", reason: "model id exists in snapshot but has no token pricing" };
  }

  // Provider exists but model key missing from snapshot.
  return { kind: "unknown" };
}

function compareSessionCreatedAt(
  a: Awaited<ReturnType<typeof readAllSessionsIndex>>[string],
  b: Awaited<ReturnType<typeof readAllSessionsIndex>>[string],
): number {
  const aCreated =
    typeof a.time?.created === "number" && Number.isFinite(a.time.created)
      ? a.time.created
      : Number.MAX_SAFE_INTEGER;
  const bCreated =
    typeof b.time?.created === "number" && Number.isFinite(b.time.created)
      ? b.time.created
      : Number.MAX_SAFE_INTEGER;

  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id.localeCompare(b.id);
}

export async function resolveSessionTree(rootSessionID: string): Promise<SessionTreeNode[]> {
  if (!rootSessionID.startsWith("ses_")) {
    throw new SessionNotFoundError(rootSessionID, "(invalid session ID format)");
  }

  const sessionsIdx = await readAllSessionsIndex();
  const root = sessionsIdx[rootSessionID];
  if (!root) {
    throw new SessionNotFoundError(rootSessionID, getOpenCodeDbPath());
  }

  const childrenByParentID = new Map<string, Array<(typeof sessionsIdx)[string]>>();
  for (const session of Object.values(sessionsIdx)) {
    if (!session.parentID) continue;
    const children = childrenByParentID.get(session.parentID);
    if (children) {
      children.push(session);
    } else {
      childrenByParentID.set(session.parentID, [session]);
    }
  }

  for (const children of childrenByParentID.values()) {
    children.sort(compareSessionCreatedAt);
  }

  const tree: SessionTreeNode[] = [];
  const visited = new Set<string>();

  const visit = (session: (typeof sessionsIdx)[string], depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);

    tree.push({
      sessionID: session.id,
      parentID: session.parentID,
      title: session.title,
      depth,
    });

    const children = childrenByParentID.get(session.id) ?? [];
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return tree;
}

export async function aggregateUsage(params: {
  sinceMs?: number;
  untilMs?: number;
  sessionID?: string;
  sessionIDs?: string[];
}): Promise<AggregateResult> {
  if (params.sessionID && params.sessionIDs?.length) {
    throw new Error("aggregateUsage received both sessionID and sessionIDs");
  }

  // Use session-scoped iterators when filtering by session ids for better performance.
  let messages: OpenCodeMessage[];
  if (params.sessionIDs) {
    messages = await iterAssistantMessagesForSessions({
      sessionIDs: params.sessionIDs,
      sinceMs: params.sinceMs,
      untilMs: params.untilMs,
    });
  } else if (params.sessionID) {
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
  const unpriced = new Map<string, UnpricedRow>();

  let pricedTotals = emptyTokenBuckets();
  let unknownTotals = emptyTokenBuckets();
  let unpricedTotals = emptyTokenBuckets();
  let costTotal = 0;
  const resolutionCache = new Map<string, PricingResolution>();

  for (const msg of messages) {
    const tokens = tokenBucketsFromMessage(msg);
    const sid = msg.sessionID;
    const sessionTitle = sessionsIdx[sid]?.title;
    const existingSessionRow = bySession.get(sid);
    if (existingSessionRow) {
      existingSessionRow.tokens = addTokenBuckets(existingSessionRow.tokens, tokens);
      existingSessionRow.messageCount += 1;
    } else {
      bySession.set(sid, {
        sessionID: sid,
        title: sessionTitle,
        tokens,
        costUsd: 0,
        messageCount: 1,
      });
    }

    const cacheKey = `${msg.providerID ?? ""}|||${msg.modelID ?? ""}`;
    const cached = resolutionCache.get(cacheKey);
    const mapping = cached ?? resolvePricingKey({ providerID: msg.providerID, modelID: msg.modelID });
    if (!cached) resolutionCache.set(cacheKey, mapping);

    if (!mapping.ok) {
      unknownTotals = addTokenBuckets(unknownTotals, tokens);
      const k = JSON.stringify(mapping.unknown);
      const row = unknown.get(k);
      if (row) {
        row.tokens = addTokenBuckets(row.tokens, tokens);
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
      const classification = classifyMissingPricing({
        mappedProvider: mapping.key.provider,
        mappedModel: mapping.key.model,
      });

      if (classification.kind === "unpriced") {
        unpricedTotals = addTokenBuckets(unpricedTotals, tokens);
        const rowKey: UnpricedKey = {
          sourceProviderID: msg.providerID ?? "unknown",
          sourceModelID: msg.modelID ?? "unknown",
          mappedProvider: mapping.key.provider,
          mappedModel: mapping.key.model,
          reason: classification.reason,
        };
        const k = JSON.stringify(rowKey);
        const row = unpriced.get(k);
        if (row) {
          row.tokens = addTokenBuckets(row.tokens, tokens);
          row.messageCount += 1;
        } else {
          unpriced.set(k, { key: rowKey, tokens, messageCount: 1 });
        }
        continue;
      }

      // Mapping succeeded but pricing missing.
      unknownTotals = addTokenBuckets(unknownTotals, tokens);
      const unk: UnknownKey = {
        sourceProviderID: msg.providerID ?? "unknown",
        sourceModelID: msg.modelID ?? "unknown",
        mappedProvider: mapping.key.provider,
        mappedModel: mapping.key.model,
      };
      const k = JSON.stringify(unk);
      const row = unknown.get(k);
      if (row) {
        row.tokens = addTokenBuckets(row.tokens, tokens);
        row.messageCount += 1;
      } else {
        unknown.set(k, { key: unk, tokens, messageCount: 1 });
      }
      continue;
    }

    pricedTotals = addTokenBuckets(pricedTotals, tokens);
    costTotal += priced.costUsd;

    // Tokscale-style: key by OpenCode source provider + source model id.
    const srcProviderID = msg.providerID ?? "unknown";
    const srcModelID = msg.modelID ?? "unknown";
    const srcModelKey = `${srcProviderID}\n${srcModelID}`;
    const sm = bySourceModel.get(srcModelKey);
    if (sm) {
      sm.tokens = addTokenBuckets(sm.tokens, tokens);
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
      src.tokens = addTokenBuckets(src.tokens, tokens);
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
      existing.tokens = addTokenBuckets(existing.tokens, tokens);
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

    const s = bySession.get(sid);
    if (s) {
      s.costUsd += priced.costUsd;
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

  const unpricedRows = Array.from(unpriced.values()).sort(
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
      unpriced: unpricedTotals,
      costUsd: costTotal,
      messageCount: messages.length,
      sessionCount: new Set(messages.map((m) => m.sessionID)).size,
    },
    bySourceProvider: bySourceProviderRows,
    bySourceModel: bySourceModelRows,
    byModel: byModelRows,
    bySession: bySessionRows,
    unknown: unknownRows,
    unpriced: unpricedRows,
  };
}

/**
 * Lightweight session token summary for toast display.
 * Returns per-model input/output totals and request count for a single session.
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
  requestCount: number;
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
    requestCount: sessionMessages.length,
  };
}
