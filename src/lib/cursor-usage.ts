import { isCursorModelId, isCursorProviderId } from "./cursor-pricing.js";
import { iterAssistantMessages } from "./opencode-storage.js";
import { priceMessage } from "./pricing-key.js";
import {
  addTokenBuckets,
  emptyTokenBuckets,
  type TokenBuckets,
  tokenBucketsFromMessage,
} from "./token-buckets.js";

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
  /** Requests of known models without a price: prompts past Cursor's long-context threshold. */
  unpricedRequestCount: number;
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
  let unpricedRequestCount = 0;

  for (const msg of messages) {
    if (!isCursorProviderId(msg.providerID) && !isCursorModelId(msg.modelID)) continue;

    const sourceModelID = msg.modelID ?? "unknown";
    const tokens = tokenBucketsFromMessage(msg);
    // Priced as the Usage tab prices it: Cursor's own table is Auto+Composer, any other price
    // (Cursor's aliases, else models.dev's normal match) the API pool.
    const price = priceMessage({ providerID: msg.providerID, modelID: msg.modelID }, tokens);
    if (price.kind === "priced") {
      accumulateBucket(price.key.provider === "cursor" ? autoComposer : api, tokens, price.usd);
      accumulateBucket(total, tokens, price.usd);
      continue;
    }

    // Requests without a price count toward the total messages and tokens, but have no cost.
    total.tokens = addTokenBuckets(total.tokens, tokens);
    total.messageCount += 1;
    if (price.kind === "unpriced") {
      unpricedRequestCount += 1;
      continue;
    }
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
    unpricedRequestCount,
  };
}
