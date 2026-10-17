import type { Amount } from "../core/types.js";
import { accountingDecimalFromNumber } from "../providers/accounting-decimal.js";
import type { ProviderRow } from "../providers/contract.js";
import type { OpenCodeMessage } from "./opencode-storage.js";
import { iterCompletedAssistantMessages } from "./opencode-storage.js";
import { priceMessage } from "./pricing-key.js";
import {
  customRow,
  type LocalEstimateQuotaProviderDefinition,
  type LocalEstimateWindow,
} from "./quota-providers.js";
import { type TokenBuckets, tokenBucketsFromMessage } from "./token-buckets.js";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** OpenCode's completed assistant messages in a time range. */
export type ReadCompletedMessages = (params: {
  completedSinceMs: number;
  completedUntilMs: number;
}) => Promise<OpenCodeMessage[]>;

/** A completed request: the message it came from and when it completed. */
interface CountedRequest {
  id: string;
  atMs: number;
  modelId: string;
  tokens: TokenBuckets;
}

/** One window's requests: when it resets and, for a UTC day, when it started. */
export interface WindowCount {
  window: LocalEstimateWindow;
  /** Oldest first. */
  requests: CountedRequest[];
  resetsAt?: string;
  windowStartedAt?: string;
}

function windowStart(window: LocalEstimateWindow, nowMs: number): number {
  if (window.type === "rolling") return nowMs - window.durationMinutes! * MINUTE_MS;
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** A completed assistant message as a request, or null when it is not one this count covers. */
function countedRequest(
  message: OpenCodeMessage,
  providerIds: readonly string[],
  modelIds: readonly string[] | undefined,
  requireModelId: boolean,
): CountedRequest | null {
  const completed = message.time?.completed;
  // Only finished requests count, timed by when they completed.
  const atMs =
    typeof completed === "number" && Number.isFinite(completed) ? Math.trunc(completed) : 0;
  const modelId = typeof message.modelID === "string" ? message.modelID : "";
  if (
    message.role !== "assistant" ||
    !message.providerID ||
    !providerIds.includes(message.providerID) ||
    (requireModelId && !modelId) ||
    (modelIds !== undefined && !modelIds.includes(modelId)) ||
    !message.id ||
    atMs <= 0
  ) {
    return null;
  }
  return { id: message.id, atMs, modelId, tokens: tokenBucketsFromMessage(message) };
}

/**
 * This machine's completed requests to `providerIds` (and `modelIds`, when given) in each
 * window, read from OpenCode's own messages since the longest window began. With
 * `requireModelId`, a message that names no model is left out. A message counts once. A rolling window resets when its oldest request leaves it; a UTC day at midnight UTC.
 */
export async function countRequestWindows(params: {
  providerIds: readonly string[];
  modelIds?: readonly string[];
  requireModelId?: boolean;
  windows: readonly LocalEstimateWindow[];
  nowMs: number;
  readMessages?: ReadCompletedMessages;
}): Promise<WindowCount[]> {
  const { nowMs } = params;
  const readMessages = params.readMessages ?? iterCompletedAssistantMessages;
  const completedSinceMs = Math.min(...params.windows.map((window) => windowStart(window, nowMs)));
  const byId = new Map<string, CountedRequest>();
  for (const message of await readMessages({ completedSinceMs, completedUntilMs: nowMs })) {
    const request = countedRequest(
      message,
      params.providerIds,
      params.modelIds,
      params.requireModelId ?? false,
    );
    if (request && request.atMs >= completedSinceMs && request.atMs <= nowMs) {
      byId.set(request.id, request);
    }
  }
  const requests = [...byId.values()].sort(
    (left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id),
  );

  return params.windows.map((window) => {
    const sinceMs = windowStart(window, nowMs);
    const inWindow = requests.filter((request) => request.atMs >= sinceMs);
    if (window.type === "utc-day") {
      return {
        window,
        requests: inWindow,
        resetsAt: new Date(sinceMs + DAY_MS).toISOString(),
        // The count covers the whole UTC day once the day has begun.
        ...(sinceMs < nowMs ? { windowStartedAt: new Date(sinceMs).toISOString() } : {}),
      };
    }
    const [oldest] = inWindow;
    return {
      window,
      requests: inWindow,
      ...(oldest
        ? { resetsAt: new Date(oldest.atMs + window.durationMinutes! * MINUTE_MS).toISOString() }
        : {}),
    };
  });
}

/** A request's cost in USD, or null when it has no price; `pricingModelMap` is a fallback. */
function requestCost(
  definition: LocalEstimateQuotaProviderDefinition,
  request: CountedRequest,
): number | null {
  const price = priceMessage(
    { providerID: definition.providerId, modelID: request.modelId },
    request.tokens,
    { modelMap: definition.pricingModelMap },
  );
  return price.kind === "priced" ? price.usd : null;
}

function requestCount(count: number): Amount {
  return { decimal: accountingDecimalFromNumber(count), unit: { kind: "count", unit: "request" } };
}

/** Dollars to the cent. */
function usdAmount(value: number): Amount {
  return {
    decimal: accountingDecimalFromNumber(Number(value.toFixed(2))),
    unit: { kind: "currency", code: "USD" },
  };
}

function clampedPercentRemaining(used: number, limit: number): number {
  return Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
}

/**
 * A local estimate's rows: each window's requests out of its limit and, with a USD budget, the
 * spend out of the budget. Each key is the part of the row id after `custom.<definition id>.`.
 */
export async function collectLocalQuotaProviderEstimate(
  definition: LocalEstimateQuotaProviderDefinition,
  dependencies: { nowMs?: number; readMessages?: ReadCompletedMessages } = {},
): Promise<{ rows: ProviderRow[] }> {
  const counts = await countRequestWindows({
    providerIds: [definition.providerId],
    modelIds: definition.modelIds,
    // A custom estimate prices each request by its model, so a request without one is skipped.
    requireModelId: true,
    windows: definition.windows,
    nowMs: dependencies.nowMs ?? Date.now(),
    readMessages: dependencies.readMessages,
  });
  const rows: ProviderRow[] = [];
  for (const { window, requests, resetsAt, windowStartedAt } of counts) {
    const started = windowStartedAt ? { windowStartedAt } : {};
    rows.push({
      ...customRow({
        key: window.id,
        name: window.label,
        resultType: "rate_limit",
        method: "local_estimation",
        value: {
          percentRemaining: clampedPercentRemaining(requests.length, window.requestLimit),
        },
        resetsAt,
      }),
      used: requestCount(requests.length),
      limit: requestCount(window.requestLimit),
      ...started,
    });

    if (window.usdBudget === undefined) continue;

    let costUsd = 0;
    let unpriced = 0;
    for (const request of requests) {
      const cost = requestCost(definition, request);
      if (cost === null) unpriced += 1;
      else costUsd += cost;
    }

    const budgetRow = (value: { percentRemaining: number } | { text: string }): ProviderRow =>
      customRow({
        // Window ids are kebab-case, so "_budget" can't collide with another window's id.
        key: `${window.id}_budget`,
        name: `${window.label} budget`,
        resultType: "budget",
        method: "local_estimation",
        value,
        resetsAt,
      });
    // A partial sum would understate spend, so any unpriced request hides the budget percent.
    if (unpriced > 0) {
      rows.push(
        budgetRow({
          text: `Unavailable (${unpriced} unpriced request${unpriced === 1 ? "" : "s"})`,
        }),
      );
    } else {
      rows.push({
        ...budgetRow({ percentRemaining: clampedPercentRemaining(costUsd, window.usdBudget) }),
        used: usdAmount(costUsd),
        limit: usdAmount(window.usdBudget),
        ...started,
      });
    }
  }
  return { rows };
}
