import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { QuotaToastEntry } from "./entries.js";
import type { OpenCodeMessage } from "./opencode-storage.js";
import { iterAssistantMessages } from "./opencode-storage.js";
import type {
  LocalEstimateQuotaProviderDefinition,
  LocalEstimateWindow,
} from "./quota-providers.js";
import type { OpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { resolvePricingKey } from "./quota-stats.js";
import { lookupCost } from "./modelsdev-pricing.js";
import { calculateUsdFromTokenBuckets } from "./token-cost.js";
import { emptyTokenBuckets, tokenBucketsFromMessage, type TokenBuckets } from "./token-buckets.js";

export const QUOTA_PROVIDER_LOCAL_STATE_VERSION = 1 as const;
const LOCAL_STATE_DIR = "opencode-quota/quota-providers";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LocalQuotaProviderMessage {
  id: string;
  atMs: number;
  providerId: string;
  modelId: string;
  tokens: TokenBuckets;
}

export interface LocalQuotaProviderStateV1 {
  version: typeof QUOTA_PROVIDER_LOCAL_STATE_VERSION;
  definitionId: string;
  providerId: string;
  updatedAt: number;
  messages: LocalQuotaProviderMessage[];
}

export type LocalQuotaProviderStateHealth =
  | "missing"
  | "healthy"
  | "malformed"
  | "version_mismatch";

export interface LocalQuotaProviderStateDiagnostics {
  path: string;
  exists: boolean;
  health: LocalQuotaProviderStateHealth;
  version: number | null;
  lastUpdatedAt: number | null;
}

export interface LocalEstimateResult {
  entries: QuotaToastEntry[];
  state: LocalQuotaProviderStateV1;
  unpricedMessageCount: number;
}

interface LocalStateDependencies {
  nowMs?: number;
  runtimeDirs?: OpencodeRuntimeDirs;
  readMessages?: (params: { sinceMs: number; untilMs: number }) => Promise<OpenCodeMessage[]>;
  readText?: (path: string) => Promise<string>;
  writeState?: (path: string, state: LocalQuotaProviderStateV1) => Promise<void>;
}

const stateMutationByPath = new Map<string, Promise<void>>();

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTokenBuckets(value: unknown): value is TokenBuckets {
  const record = asRecord(value);
  if (
    !record ||
    !hasOnlyKeys(record, ["input", "output", "reasoning", "cache_read", "cache_write"])
  ) {
    return false;
  }
  return ["input", "output", "reasoning", "cache_read", "cache_write"].every(
    (key) =>
      typeof record[key] === "number" && Number.isFinite(record[key]) && Number(record[key]) >= 0,
  );
}

function normalizeMessage(value: unknown): LocalQuotaProviderMessage | null {
  const record = asRecord(value);
  if (
    !record ||
    !hasOnlyKeys(record, ["id", "atMs", "providerId", "modelId", "tokens"]) ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.atMs !== "number" ||
    !Number.isFinite(record.atMs) ||
    record.atMs <= 0 ||
    typeof record.providerId !== "string" ||
    record.providerId.length === 0 ||
    typeof record.modelId !== "string" ||
    record.modelId.length === 0 ||
    !isTokenBuckets(record.tokens)
  ) {
    return null;
  }
  return {
    id: record.id,
    atMs: Math.trunc(record.atMs),
    providerId: record.providerId,
    modelId: record.modelId,
    tokens: { ...record.tokens },
  };
}

function normalizeState(
  value: unknown,
  definition: LocalEstimateQuotaProviderDefinition,
): { state: LocalQuotaProviderStateV1; health: LocalQuotaProviderStateHealth } {
  const record = asRecord(value);
  if (!record) return { state: emptyState(definition, 0), health: "malformed" };
  if (record.version !== QUOTA_PROVIDER_LOCAL_STATE_VERSION) {
    return { state: emptyState(definition, 0), health: "version_mismatch" };
  }
  if (
    !hasOnlyKeys(record, ["version", "definitionId", "providerId", "updatedAt", "messages"]) ||
    record.definitionId !== definition.id ||
    record.providerId !== definition.providerId ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt) ||
    record.updatedAt < 0 ||
    !Array.isArray(record.messages)
  ) {
    return { state: emptyState(definition, 0), health: "malformed" };
  }

  const messages: LocalQuotaProviderMessage[] = [];
  for (const value of record.messages) {
    const message = normalizeMessage(value);
    if (!message) return { state: emptyState(definition, 0), health: "malformed" };
    messages.push(message);
  }
  return {
    state: {
      version: QUOTA_PROVIDER_LOCAL_STATE_VERSION,
      definitionId: definition.id,
      providerId: definition.providerId,
      updatedAt: Math.trunc(record.updatedAt),
      messages,
    },
    health: "healthy",
  };
}

function emptyState(
  definition: LocalEstimateQuotaProviderDefinition,
  updatedAt: number,
): LocalQuotaProviderStateV1 {
  return {
    version: QUOTA_PROVIDER_LOCAL_STATE_VERSION,
    definitionId: definition.id,
    providerId: definition.providerId,
    updatedAt,
    messages: [],
  };
}

export function getLocalQuotaProviderStatePath(
  definitionId: string,
  runtimeDirs: OpencodeRuntimeDirs = getOpencodeRuntimeDirs(),
): string {
  return join(runtimeDirs.stateDir, LOCAL_STATE_DIR, `${definitionId}.json`);
}

function utcDayStart(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function windowStart(window: LocalEstimateWindow, nowMs: number): number {
  return window.type === "utc-day"
    ? utcDayStart(nowMs)
    : nowMs - window.durationMinutes! * 60 * 1000;
}

function retentionStart(definition: LocalEstimateQuotaProviderDefinition, nowMs: number): number {
  return Math.min(...definition.windows.map((window) => windowStart(window, nowMs)));
}

function messageTimestamp(message: OpenCodeMessage): number | null {
  const value = message.time?.completed ?? message.time?.created;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function matchesDefinition(
  definition: LocalEstimateQuotaProviderDefinition,
  message: OpenCodeMessage,
): boolean {
  return (
    message.role === "assistant" &&
    message.providerID === definition.providerId &&
    typeof message.modelID === "string" &&
    (definition.modelIds === undefined || definition.modelIds.includes(message.modelID))
  );
}

function toStateMessage(message: OpenCodeMessage): LocalQuotaProviderMessage | null {
  const atMs = messageTimestamp(message);
  if (!atMs || !message.providerID || !message.modelID || !message.id) return null;
  return {
    id: message.id,
    atMs,
    providerId: message.providerID,
    modelId: message.modelID,
    tokens: tokenBucketsFromMessage(message),
  };
}

async function withStateMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = stateMutationByPath.get(path) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  stateMutationByPath.set(path, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stateMutationByPath.get(path) === queued) stateMutationByPath.delete(path);
  }
}

async function readState(
  path: string,
  definition: LocalEstimateQuotaProviderDefinition,
  readText: (path: string) => Promise<string>,
): Promise<{ state: LocalQuotaProviderStateV1; health: LocalQuotaProviderStateHealth }> {
  try {
    return normalizeState(JSON.parse(await readText(path)) as unknown, definition);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code?: unknown }).code) === "ENOENT"
    ) {
      return { state: emptyState(definition, 0), health: "missing" };
    }
    return { state: emptyState(definition, 0), health: "malformed" };
  }
}

export async function syncLocalQuotaProviderState(
  definition: LocalEstimateQuotaProviderDefinition,
  dependencies: LocalStateDependencies = {},
): Promise<LocalQuotaProviderStateV1> {
  const nowMs = dependencies.nowMs ?? Date.now();
  const path = getLocalQuotaProviderStatePath(definition.id, dependencies.runtimeDirs);
  const readText = dependencies.readText ?? ((target) => readFile(target, "utf8"));
  const readMessages =
    dependencies.readMessages ??
    ((params) => iterAssistantMessages({ sinceMs: params.sinceMs, untilMs: params.untilMs }));
  const writeState =
    dependencies.writeState ??
    ((target, state) => writeJsonAtomic(target, state, { trailingNewline: true }));

  return withStateMutation(path, async () => {
    const { state } = await readState(path, definition, readText);
    const sinceMs = retentionStart(definition, nowMs);
    const fresh = await readMessages({ sinceMs, untilMs: nowMs });

    const byId = new Map<string, LocalQuotaProviderMessage>();
    for (const message of state.messages) {
      if (message.atMs >= sinceMs && message.atMs <= nowMs) byId.set(message.id, message);
    }
    for (const raw of fresh) {
      if (!matchesDefinition(definition, raw)) continue;
      const message = toStateMessage(raw);
      if (message && message.atMs >= sinceMs && message.atMs <= nowMs) {
        byId.set(message.id, message);
      }
    }

    const next: LocalQuotaProviderStateV1 = {
      version: QUOTA_PROVIDER_LOCAL_STATE_VERSION,
      definitionId: definition.id,
      providerId: definition.providerId,
      updatedAt: nowMs,
      messages: [...byId.values()].sort(
        (left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id),
      ),
    };
    await writeState(path, next);
    return next;
  });
}

function resolveMessageCost(
  definition: LocalEstimateQuotaProviderDefinition,
  message: LocalQuotaProviderMessage,
): number | null {
  const automatic = resolvePricingKey({
    providerID: message.providerId,
    modelID: message.modelId,
  });
  if (automatic.ok) {
    const rates = lookupCost(automatic.key.provider, automatic.key.model);
    return rates ? calculateUsdFromTokenBuckets(rates, message.tokens) : null;
  }

  const manual = definition.pricingModelMap?.[message.modelId];
  if (!manual) return null;
  const slash = manual.indexOf("/");
  const rates = lookupCost(manual.slice(0, slash), manual.slice(slash + 1));
  return rates ? calculateUsdFromTokenBuckets(rates, message.tokens) : null;
}

function nextUtcMidnight(nowMs: number): string {
  return new Date(utcDayStart(nowMs) + DAY_MS).toISOString();
}

function rollingReset(
  messages: readonly LocalQuotaProviderMessage[],
  window: LocalEstimateWindow,
): string | undefined {
  const oldest = messages[0];
  return oldest
    ? new Date(oldest.atMs + window.durationMinutes! * 60 * 1000).toISOString()
    : undefined;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function percentRemaining(used: number, limit: number): number {
  return ((limit - used) / limit) * 100;
}

export function computeLocalQuotaProviderEstimate(params: {
  definition: LocalEstimateQuotaProviderDefinition;
  state: LocalQuotaProviderStateV1;
  nowMs?: number;
}): LocalEstimateResult {
  const nowMs = params.nowMs ?? Date.now();
  const entries: QuotaToastEntry[] = [];
  let totalUnpriced = 0;

  for (const window of params.definition.windows) {
    const sinceMs = windowStart(window, nowMs);
    const messages = params.state.messages.filter(
      (message) => message.atMs >= sinceMs && message.atMs <= nowMs,
    );
    const resetTimeIso =
      window.type === "utc-day" ? nextUtcMidnight(nowMs) : rollingReset(messages, window);

    entries.push({
      accounting: {
        resultType: "rate_limit",
        acquisitionMethod: "local_estimation",
        ownership: "user_configured",
        authority: "locally_derived",
        sourceId: params.definition.id,
        observedAtIso: new Date(params.state.updatedAt).toISOString(),
      },
      kind: "percent",
      name: `${params.definition.label} ${window.label}`,
      group: params.definition.label,
      label: `${window.label}:`,
      right: `${messages.length}/${window.requestLimit}`,
      percentRemaining: percentRemaining(messages.length, window.requestLimit),
      ...(resetTimeIso ? { resetTimeIso } : {}),
    });

    if (window.usdBudget === undefined) continue;

    let costUsd = 0;
    let unpriced = 0;
    for (const message of messages) {
      const cost = resolveMessageCost(params.definition, message);
      if (cost === null) unpriced += 1;
      else costUsd += cost;
    }
    totalUnpriced += unpriced;

    const common = {
      accounting: {
        resultType: "budget" as const,
        acquisitionMethod: "local_estimation" as const,
        ownership: "user_configured" as const,
        authority: "locally_derived" as const,
        sourceId: params.definition.id,
        observedAtIso: new Date(params.state.updatedAt).toISOString(),
      },
      name: `${params.definition.label} ${window.label} budget`,
      group: params.definition.label,
      label: `${window.label} budget:`,
      ...(resetTimeIso ? { resetTimeIso } : {}),
    };
    if (unpriced > 0) {
      entries.push({
        ...common,
        kind: "value",
        value: `Unavailable (${unpriced} unpriced request${unpriced === 1 ? "" : "s"})`,
      });
    } else {
      entries.push({
        ...common,
        kind: "percent",
        right: `${formatUsd(costUsd)}/${formatUsd(window.usdBudget)}`,
        percentRemaining: percentRemaining(costUsd, window.usdBudget),
      });
    }
  }

  return { entries, state: params.state, unpricedMessageCount: totalUnpriced };
}

export async function collectLocalQuotaProviderEstimate(
  definition: LocalEstimateQuotaProviderDefinition,
  dependencies: LocalStateDependencies = {},
): Promise<LocalEstimateResult> {
  const state = await syncLocalQuotaProviderState(definition, dependencies);
  return computeLocalQuotaProviderEstimate({
    definition,
    state,
    ...(dependencies.nowMs !== undefined ? { nowMs: dependencies.nowMs } : {}),
  });
}

export async function inspectLocalQuotaProviderState(
  definition: LocalEstimateQuotaProviderDefinition,
  dependencies: Pick<LocalStateDependencies, "runtimeDirs" | "readText"> = {},
): Promise<LocalQuotaProviderStateDiagnostics> {
  const path = getLocalQuotaProviderStatePath(definition.id, dependencies.runtimeDirs);
  const readText = dependencies.readText ?? ((target) => readFile(target, "utf8"));
  try {
    const raw = JSON.parse(await readText(path)) as unknown;
    const record = asRecord(raw);
    const version = typeof record?.version === "number" ? record.version : null;
    const normalized = normalizeState(raw, definition);
    let lastUpdatedAt: number | null = null;
    try {
      const fileStats = await stat(path);
      lastUpdatedAt =
        normalized.health === "healthy" ? normalized.state.updatedAt : fileStats.mtimeMs;
    } catch {
      lastUpdatedAt = normalized.health === "healthy" ? normalized.state.updatedAt : null;
    }
    return {
      path,
      exists: true,
      health: normalized.health,
      version,
      lastUpdatedAt,
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code?: unknown }).code) === "ENOENT"
    ) {
      return { path, exists: false, health: "missing", version: null, lastUpdatedAt: null };
    }
    return { path, exists: true, health: "malformed", version: null, lastUpdatedAt: null };
  }
}

export function __resetLocalQuotaProviderStateForTests(): void {
  stateMutationByPath.clear();
}
