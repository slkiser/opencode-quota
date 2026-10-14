/**
 * Budget alert configuration and evaluation engine.
 *
 * Users define threshold rules (e.g. "alert when daily spend > $5 on OpenAI")
 * and the engine evaluates current usage against these rules.
 *
 * Config persisted at ~/.config/opencode-quota/budget-alerts.json
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type { TokenBuckets } from "./token-buckets.js";

// =============================================================================
// Types
// =============================================================================

export const BUDGET_ALERTS_VERSION = 1 as const;
export const BUDGET_ALERTS_DIRNAME = "opencode-quota";
export const BUDGET_ALERTS_FILENAME = "budget-alerts.json";

export type BudgetTimeWindow =
  | "day" // rolling 24 hours
  | "week" // rolling 7 days
  | "month" // rolling 30 days
  | "all"; // all available history

export type BudgetThresholdMetric =
  | "cost_usd" // USD spend
  | "tokens_total" // total tokens (input + output + reasoning + cache)
  | "tokens_input"
  | "tokens_output";

export type BudgetAlertScope = {
  /** "global" = all providers combined; "provider" = specific provider; "model" = specific provider+model */
  type: "global" | "provider" | "model";
  providerId?: string;
  modelId?: string;
};

export interface BudgetAlertRule {
  /** Unique rule ID (generated) */
  id: string;
  /** Whether this rule is active */
  enabled: boolean;
  /** Human-readable name (e.g. "OpenAI daily cap") */
  name: string;
  /** Scope of the alert */
  scope: BudgetAlertScope;
  /** Time window to evaluate */
  window: BudgetTimeWindow;
  /** What to measure */
  metric: BudgetThresholdMetric;
  /** Threshold value (cost in USD, or token count) */
  threshold: number;
  /** When alert should trigger: "above" = usage exceeds threshold, "below" = usage falls below (for remaining-quota alerts) */
  direction: "above" | "below";
  /** When this rule was created (epoch ms) */
  createdAt: number;
  /** When this rule was last updated (epoch ms) */
  updatedAt: number;
}

export interface BudgetAlertResult {
  rule: BudgetAlertRule;
  /** Whether the alert is currently triggered */
  triggered: boolean;
  /** Current usage value for the metric */
  currentValue: number;
  /** Percentage of threshold used (0-100+). Only meaningful for "above" direction. */
  percentUsed: number;
  /** Human-readable description of the alert state */
  message: string;
  /** When this evaluation was performed (epoch ms) */
  evaluatedAt: number;
}

export interface BudgetAlertUsage {
  /** Token buckets for the scope */
  tokens: TokenBuckets;
  /** USD cost for the scope */
  costUsd: number;
  /** Number of messages in the window */
  messageCount: number;
}

export interface BudgetAlertStore {
  version: typeof BUDGET_ALERTS_VERSION;
  rules: BudgetAlertRule[];
}

// =============================================================================
// In-memory cache
// =============================================================================

let cachedStore: BudgetAlertStore | null = null;
let storeLoadedAt = 0;
const STORE_CACHE_TTL_MS = 30_000;

// =============================================================================
// Path resolution
// =============================================================================

function getBudgetAlertsFilePath(): string {
  const { configDir } = getOpencodeRuntimeDirs();
  return join(configDir, BUDGET_ALERTS_DIRNAME, BUDGET_ALERTS_FILENAME);
}

// =============================================================================
// Store I/O
// =============================================================================

function emptyStore(): BudgetAlertStore {
  return { version: BUDGET_ALERTS_VERSION, rules: [] };
}

async function loadStore(forceReload = false, strictReads = false): Promise<BudgetAlertStore> {
  const now = Date.now();
  if (!forceReload && cachedStore && now - storeLoadedAt < STORE_CACHE_TTL_MS) {
    return cachedStore;
  }

  const filePath = getBudgetAlertsFilePath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.rules)) {
      cachedStore = parsed as BudgetAlertStore;
    } else {
      if (strictReads) throw new Error("Budget rules unavailable");
      cachedStore = emptyStore();
    }
  } catch (error) {
    if (strictReads && (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Budget rules unavailable");
    cachedStore = emptyStore();
  }
  storeLoadedAt = now;
  return cachedStore;
}

async function saveStore(store: BudgetAlertStore): Promise<void> {
  const filePath = getBudgetAlertsFilePath();
  await writeJsonAtomic(filePath, store, { trailingNewline: true });
  cachedStore = store;
  storeLoadedAt = Date.now();
}

// =============================================================================
// Window resolution
// =============================================================================

/**
 * Get the sinceMs timestamp for a given time window.
 */
export function getWindowSinceMs(window: BudgetTimeWindow): number | undefined {
  const now = Date.now();
  switch (window) {
    case "day":
      return now - 24 * 60 * 60 * 1000;
    case "week":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "month":
      return now - 30 * 24 * 60 * 60 * 1000;
    case "all":
      return undefined; // no lower bound
  }
}

/**
 * Get a human-readable label for a time window.
 */
export function getWindowLabel(window: BudgetTimeWindow): string {
  switch (window) {
    case "day":
      return "24 hours";
    case "week":
      return "7 days";
    case "month":
      return "30 days";
    case "all":
      return "All time";
  }
}

// =============================================================================
// Metrics extraction
// =============================================================================

function getMetricValue(usage: BudgetAlertUsage, metric: BudgetThresholdMetric): number {
  switch (metric) {
    case "cost_usd":
      return usage.costUsd;
    case "tokens_total":
      return (
        usage.tokens.input +
        usage.tokens.output +
        usage.tokens.reasoning +
        usage.tokens.cache_read +
        usage.tokens.cache_write
      );
    case "tokens_input":
      return usage.tokens.input;
    case "tokens_output":
      return usage.tokens.output;
  }
}

function formatMetricValue(value: number, metric: BudgetThresholdMetric): string {
  switch (metric) {
    case "cost_usd":
      return `$${value.toFixed(2)}`;
    case "tokens_total":
    case "tokens_input":
    case "tokens_output":
      return value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : value >= 1_000
          ? `${(value / 1_000).toFixed(1)}K`
          : String(value);
  }
}

// =============================================================================
// Rule scope matching
// =============================================================================

function scopeMatches(scope: BudgetAlertScope, providerId?: string, modelId?: string): boolean {
  switch (scope.type) {
    case "global":
      return true;
    case "provider":
      return scope.providerId === providerId;
    case "model":
      return scope.providerId === providerId && scope.modelId === modelId;
  }
}

// =============================================================================
// Public API
// =============================================================================

let idCounter = 0;

function generateRuleId(): string {
  idCounter++;
  return `balert_${Date.now()}_${idCounter}_${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * Get all budget alert rules.
 */
export async function getBudgetAlertRules(
  options: { strictReads?: boolean; forceReload?: boolean } = {},
): Promise<BudgetAlertRule[]> {
  const store = await loadStore(options.forceReload, options.strictReads);
  if (
    options.strictReads &&
    (store.version !== BUDGET_ALERTS_VERSION ||
      store.rules.some(
        (rule) =>
          !rule ||
          typeof rule.id !== "string" ||
          typeof rule.enabled !== "boolean" ||
          !["day", "week", "month", "all"].includes(rule.window) ||
          !["cost_usd", "tokens_total", "tokens_input", "tokens_output"].includes(rule.metric) ||
          !["above", "below"].includes(rule.direction) ||
          !Number.isFinite(rule.threshold) ||
          rule.threshold <= 0 ||
          !rule.scope ||
          !["global", "provider", "model"].includes(rule.scope.type) ||
          (rule.scope.type !== "global" && !rule.scope.providerId) ||
          (rule.scope.type === "model" && !rule.scope.modelId),
      ))
  )
    throw new Error("Budget rules unavailable");
  return [...store.rules];
}

/**
 * Get a single rule by ID.
 */
export async function getBudgetAlertRule(id: string): Promise<BudgetAlertRule | null> {
  const store = await loadStore();
  return store.rules.find((r) => r.id === id) ?? null;
}

/**
 * Create a new budget alert rule.
 */
export async function createBudgetAlertRule(params: {
  name: string;
  scope: BudgetAlertScope;
  window: BudgetTimeWindow;
  metric: BudgetThresholdMetric;
  threshold: number;
  direction: "above" | "below";
  enabled?: boolean;
}): Promise<BudgetAlertRule> {
  const store = await loadStore();
  const now = Date.now();
  const rule: BudgetAlertRule = {
    id: generateRuleId(),
    enabled: params.enabled ?? true,
    name: params.name,
    scope: params.scope,
    window: params.window,
    metric: params.metric,
    threshold: params.threshold,
    direction: params.direction,
    createdAt: now,
    updatedAt: now,
  };
  store.rules.push(rule);
  await saveStore(store);
  return rule;
}

/**
 * Update an existing budget alert rule.
 * Returns the updated rule, or null if the rule was not found.
 */
export async function updateBudgetAlertRule(
  id: string,
  params: Partial<Omit<BudgetAlertRule, "id" | "createdAt">>,
): Promise<BudgetAlertRule | null> {
  const store = await loadStore();
  const idx = store.rules.findIndex((r) => r.id === id);
  if (idx === -1) return null;

  const existing = store.rules[idx]!;
  const updated: BudgetAlertRule = {
    ...existing,
    ...params,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  store.rules[idx] = updated;
  await saveStore(store);
  return updated;
}

/**
 * Delete a budget alert rule.
 * Returns true if removed, false if not found.
 */
export async function deleteBudgetAlertRule(id: string): Promise<boolean> {
  const store = await loadStore();
  const idx = store.rules.findIndex((r) => r.id === id);
  if (idx === -1) return false;

  store.rules.splice(idx, 1);
  await saveStore(store);
  return true;
}

/**
 * Evaluate a single rule against usage data.
 */
export function evaluateBudgetAlert(
  rule: BudgetAlertRule,
  usage: BudgetAlertUsage,
): BudgetAlertResult {
  if (!rule.enabled) {
    return {
      rule,
      triggered: false,
      currentValue: 0,
      percentUsed: 0,
      message: "Rule is disabled",
      evaluatedAt: Date.now(),
    };
  }

  const currentValue = getMetricValue(usage, rule.metric);
  const percentUsed = rule.threshold > 0 ? (currentValue / rule.threshold) * 100 : 0;

  let triggered = false;
  let message = "";

  if (rule.direction === "above") {
    triggered = currentValue > rule.threshold;
    const fmtVal = formatMetricValue(currentValue, rule.metric);
    const fmtThresh = formatMetricValue(rule.threshold, rule.metric);
    message = triggered
      ? `${fmtVal} exceeds ${fmtThresh} limit (${percentUsed.toFixed(0)}%)`
      : `${fmtVal} of ${fmtThresh} (${percentUsed.toFixed(0)}%)`;
  } else {
    // "below" — alert when remaining falls below threshold (e.g. monthly quota running low)
    triggered = currentValue < rule.threshold;
    const fmtVal = formatMetricValue(currentValue, rule.metric);
    const fmtThresh = formatMetricValue(rule.threshold, rule.metric);
    message = triggered
      ? `${fmtVal} below minimum threshold of ${fmtThresh}`
      : `${fmtVal} above threshold of ${fmtThresh}`;
  }

  return {
    rule,
    triggered,
    currentValue,
    percentUsed,
    message,
    evaluatedAt: Date.now(),
  };
}

/**
 * Evaluate all enabled rules against a map of scope → usage data.
 *
 * @param rules - All alert rules to evaluate
 * @param usageMap - Map from "provider/model" key to usage data.
 *   Also supports a special "__global__" key for global scope usage.
 * @returns Array of alert results (one per enabled rule).
 */
export function evaluateAllBudgetAlerts(
  rules: BudgetAlertRule[],
  usageMap: Map<string, BudgetAlertUsage>,
): BudgetAlertResult[] {
  const globalUsage = usageMap.get("__global__");
  const results: BudgetAlertResult[] = [];

  for (const rule of rules) {
    let usage: BudgetAlertUsage | undefined;

    switch (rule.scope.type) {
      case "global":
        usage = globalUsage ?? {
          tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0,
          messageCount: 0,
        };
        break;
      case "provider":
        // Try all model-level keys within this provider and aggregate
        usage = aggregateProviderUsage(usageMap, rule.scope.providerId!);
        break;
      case "model":
        usage = usageMap.get(`${rule.scope.providerId}/${rule.scope.modelId}`);
        break;
    }

    if (!usage) {
      results.push({
        rule,
        triggered: false,
        currentValue: 0,
        percentUsed: 0,
        message: "No usage data available for this scope",
        evaluatedAt: Date.now(),
      });
      continue;
    }

    results.push(evaluateBudgetAlert(rule, usage));
  }

  return results;
}

/**
 * Aggregate all model-level usage entries for a given provider.
 */
function aggregateProviderUsage(
  usageMap: Map<string, BudgetAlertUsage>,
  providerId: string,
): BudgetAlertUsage {
  const prefix = `${providerId}/`;
  let tokens: TokenBuckets = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  let costUsd = 0;
  let messageCount = 0;

  for (const [key, usage] of usageMap) {
    if (key.startsWith(prefix) || key === providerId) {
      tokens = {
        input: tokens.input + usage.tokens.input,
        output: tokens.output + usage.tokens.output,
        reasoning: tokens.reasoning + usage.tokens.reasoning,
        cache_read: tokens.cache_read + usage.tokens.cache_read,
        cache_write: tokens.cache_write + usage.tokens.cache_write,
      };
      costUsd += usage.costUsd;
      messageCount += usage.messageCount;
    }
  }

  return { tokens, costUsd, messageCount };
}

/**
 * Get a human-readable description for an alert scope.
 */
export function describeScope(scope: BudgetAlertScope): string {
  switch (scope.type) {
    case "global":
      return "All providers";
    case "provider":
      return scope.providerId ?? "Unknown provider";
    case "model":
      return `${scope.providerId ?? "?"}/${scope.modelId ?? "?"}`;
  }
}

/**
 * Invalidate the in-memory cache.
 */
export function clearBudgetAlertsCache(): void {
  cachedStore = null;
  storeLoadedAt = 0;
}

/**
 * Preload the store into memory.
 */
export async function preloadBudgetAlerts(): Promise<void> {
  await loadStore(true);
}
