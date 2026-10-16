import {
  isCursorModelId,
  isCursorProviderId,
  lookupCursorLocalCost,
  resolveCursorModel,
} from "./cursor-pricing.js";
import { lookupCost } from "./modelsdev-pricing.js";
import { iterAssistantMessages } from "./opencode-storage.js";
import { resolvePricingKey } from "./pricing-key.js";
import {
  addTokenBuckets,
  emptyTokenBuckets,
  type TokenBuckets,
  tokenBucketsFromMessage,
} from "./token-buckets.js";
import { calculateUsdFromTokenBuckets } from "./token-cost.js";

interface CursorCycleWindow {
  sinceMs: number;
  untilMs: number;
  resetTimeIso: string;
  source: "configured_day" | "calendar_month";
}

interface CursorUsageBucket {
  costUsd: number;
  tokens: TokenBuckets;
  messageCount: number;
}

interface CursorUsageSummary {
  window: CursorCycleWindow;
  observedAtMs: number;
  api: CursorUsageBucket;
  autoComposer: CursorUsageBucket;
  total: CursorUsageBucket;
  unknownModels: Array<{ sourceModelID: string; messageCount: number; tokens: TokenBuckets }>;
}

function emptyUsageBucket(): CursorUsageBucket {
  return { costUsd: 0, tokens: emptyTokenBuckets(), messageCount: 0 };
}

function accumulateBucket(bucket: CursorUsageBucket, tokens: TokenBuckets, costUsd: number): void {
  bucket.tokens = addTokenBuckets(bucket.tokens, tokens);
  bucket.costUsd += costUsd;
  bucket.messageCount += 1;
}

/** A configured start day (1-28) sets the cycle; otherwise the cycle is the calendar month. */
export function computeCursorCycleWindow(params?: {
  nowMs?: number;
  billingCycleStartDay?: number;
}): CursorCycleWindow {
  const nowMs = params?.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const day = params?.billingCycleStartDay;
  const isConfiguredDay = typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 28;
  const startDay = isConfiguredDay ? day : 1;

  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), startDay);
  const start =
    nowMs >= currentMonthStart.getTime()
      ? currentMonthStart
      : new Date(now.getFullYear(), now.getMonth() - 1, startDay);
  const reset = new Date(start.getFullYear(), start.getMonth() + 1, startDay);
  return {
    sinceMs: start.getTime(),
    untilMs: reset.getTime(),
    resetTimeIso: reset.toISOString(),
    source: isConfiguredDay ? "configured_day" : "calendar_month",
  };
}

export async function getCurrentCursorUsageSummary(params?: {
  nowMs?: number;
  billingCycleStartDay?: number;
}): Promise<CursorUsageSummary> {
  const nowMs = params?.nowMs ?? Date.now();
  const window = computeCursorCycleWindow({
    nowMs,
    billingCycleStartDay: params?.billingCycleStartDay,
  });
  const messages = await iterAssistantMessages({ sinceMs: window.sinceMs, untilMs: nowMs });

  const api = emptyUsageBucket();
  const autoComposer = emptyUsageBucket();
  const total = emptyUsageBucket();
  const unknownModels = new Map<string, CursorUsageSummary["unknownModels"][number]>();

  for (const msg of messages) {
    if (!isCursorProviderId(msg.providerID) && !isCursorModelId(msg.modelID)) continue;

    const sourceModelID = msg.modelID ?? "unknown";
    const tokens = tokenBucketsFromMessage(msg);
    const resolved = resolveCursorModel(sourceModelID);

    if (resolved.kind === "local") {
      const cost = lookupCursorLocalCost(resolved.model);
      if (!cost) continue;
      const costUsd = calculateUsdFromTokenBuckets(cost, tokens);
      accumulateBucket(autoComposer, tokens, costUsd);
      accumulateBucket(total, tokens, costUsd);
      continue;
    }

    if (resolved.kind === "official") {
      const mapped = resolvePricingKey({
        providerID: resolved.providerHint,
        modelID: `${resolved.providerHint}/${resolved.modelHint}`,
      });
      if (mapped.ok) {
        const cost = lookupCost(mapped.key.provider, mapped.key.model);
        if (cost) {
          const costUsd = calculateUsdFromTokenBuckets(cost, tokens);
          accumulateBucket(api, tokens, costUsd);
          accumulateBucket(total, tokens, costUsd);
          continue;
        }
      }
    }

    // Unknown models count toward the total messages and tokens, but have no cost.
    total.tokens = addTokenBuckets(total.tokens, tokens);
    total.messageCount += 1;
    const unknown = unknownModels.get(sourceModelID);
    if (unknown) {
      unknown.tokens = addTokenBuckets(unknown.tokens, tokens);
      unknown.messageCount += 1;
    } else {
      unknownModels.set(sourceModelID, { sourceModelID, messageCount: 1, tokens });
    }
  }

  return {
    window,
    observedAtMs: nowMs,
    api,
    autoComposer,
    total,
    unknownModels: [...unknownModels.values()].sort((a, b) => b.messageCount - a.messageCount),
  };
}
