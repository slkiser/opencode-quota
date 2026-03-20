import { readFileSync } from "fs";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { fetchWithTimeout } from "./http.js";
import { getOpencodeRuntimeDirs, type OpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type { PricingSnapshotSource } from "./types.js";

const SOURCE_URL = "https://models.dev/api.json";
const DEFAULT_MODELSDEV_PROVIDERS = ["anthropic", "google", "moonshotai", "openai", "xai", "zai"];
const COST_KEYS = ["input", "output", "cache_read", "cache_write"] as const;
const RUNTIME_SNAPSHOT_FILENAME = "modelsdev-pricing.runtime.min.json";
const RUNTIME_REFRESH_STATE_FILENAME = "modelsdev-pricing.refresh-state.json";
const DEFAULT_REFRESH_MIN_ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 6_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CostBuckets = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};

export type PricingSnapshot = {
  _meta: {
    source: string;
    generatedAt: number;
    providers: string[];
    units: string;
  };
  providers: Record<string, Record<string, CostBuckets>>;
};

export const DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export type PricingSnapshotHealth = {
  generatedAt: number;
  ageMs: number;
  maxAgeMs: number;
  stale: boolean;
};

export interface PricingRefreshStateV1 {
  version: 1;
  updatedAt: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastResult?: "success" | "not_modified" | "skipped_fresh" | "skipped_throttled" | "failed";
  lastError?: string;
  etag?: string;
  lastModified?: string;
}

export interface PricingRefreshPolicy {
  enabled: boolean;
  maxAgeMs: number;
  minAttemptIntervalMs: number;
  timeoutMs: number;
}

export interface PricingRefreshOptions {
  reason?: "init" | "tokens" | "status" | "manual";
  force?: boolean;
  nowMs?: number;
  maxAgeMs?: number;
  minAttemptIntervalMs?: number;
  timeoutMs?: number;
  runtimeDirs?: OpencodeRuntimeDirs;
  fetchFn?: typeof fetch;
  bootstrapSnapshotOverride?: PricingSnapshot;
  providerAllowlist?: string[];
  snapshotSelection?: PricingSnapshotSource;
  allowRefreshWhenSelectionBundled?: boolean;
}

export interface PricingRefreshResult {
  attempted: boolean;
  updated: boolean;
  state: PricingRefreshStateV1;
  error?: string;
  reason?: string;
}

const EMPTY_SNAPSHOT: PricingSnapshot = {
  _meta: {
    source: "none",
    generatedAt: 0,
    providers: [],
    units: "USD per 1M tokens",
  },
  providers: {},
};

let SNAPSHOT: PricingSnapshot | null = null;
let SNAPSHOT_SOURCE: "runtime" | "bundled" | "empty" = "bundled";
let SNAPSHOT_SELECTION: PricingSnapshotSource = "auto";
let MODEL_INDEX: Map<string, string[]> | null = null;
let REFRESH_IN_FLIGHT: Promise<PricingRefreshResult> | null = null;
let PROCESS_REFRESH_CHECKED = false;
let CONFIGURED_PRICING_SNAPSHOT_MAX_AGE_MS = DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function sortRecordByKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(obj).sort((a, b) => a.localeCompare(b))) {
    out[key] = obj[key];
  }
  return out;
}

function pricingSnapshotDaysToMs(days: number | undefined): number {
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    return DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
  }
  return Math.floor(days * MS_PER_DAY);
}

export function getPricingRefreshPolicy(): PricingRefreshPolicy {
  return {
    enabled: true,
    maxAgeMs: CONFIGURED_PRICING_SNAPSHOT_MAX_AGE_MS,
    minAttemptIntervalMs: DEFAULT_REFRESH_MIN_ATTEMPT_INTERVAL_MS,
    timeoutMs: DEFAULT_REFRESH_TIMEOUT_MS,
  };
}

export function setPricingSnapshotAutoRefresh(days: number): void {
  CONFIGURED_PRICING_SNAPSHOT_MAX_AGE_MS = pricingSnapshotDaysToMs(days);
}

function normalizeSnapshot(raw: unknown): PricingSnapshot | null {
  const root = asRecord(raw);
  if (!root) return null;

  const metaRaw = asRecord(root._meta);
  const providersRaw = asRecord(root.providers);
  if (!metaRaw || !providersRaw) return null;

  const generatedAt = Number(metaRaw.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) return null;

  const providers: Record<string, Record<string, CostBuckets>> = {};

  for (const providerId of Object.keys(providersRaw)) {
    const modelsRaw = asRecord(providersRaw[providerId]);
    if (!modelsRaw) continue;

    const models: Record<string, CostBuckets> = {};
    for (const modelId of Object.keys(modelsRaw)) {
      const modelRaw = asRecord(modelsRaw[modelId]);
      if (!modelRaw) continue;

      const buckets: CostBuckets = {};
      const input = modelRaw.input;
      const output = modelRaw.output;
      const cacheRead = modelRaw.cache_read;
      const cacheWrite = modelRaw.cache_write;
      const reasoning = modelRaw.reasoning;

      if (typeof input === "number" && Number.isFinite(input)) buckets.input = input;
      if (typeof output === "number" && Number.isFinite(output)) buckets.output = output;
      if (typeof cacheRead === "number" && Number.isFinite(cacheRead)) buckets.cache_read = cacheRead;
      if (typeof cacheWrite === "number" && Number.isFinite(cacheWrite)) {
        buckets.cache_write = cacheWrite;
      }
      if (typeof reasoning === "number" && Number.isFinite(reasoning)) buckets.reasoning = reasoning;

      if (Object.keys(buckets).length > 0) {
        models[modelId] = buckets;
      }
    }

    if (Object.keys(models).length > 0) {
      providers[providerId] = sortRecordByKeys(models);
    }
  }

  const providerList = Object.keys(providers).sort((a, b) => a.localeCompare(b));

  return {
    _meta: {
      source: typeof metaRaw.source === "string" && metaRaw.source ? metaRaw.source : SOURCE_URL,
      generatedAt: Math.trunc(generatedAt),
      providers: providerList,
      units:
        typeof metaRaw.units === "string" && metaRaw.units ? metaRaw.units : "USD per 1M tokens",
    },
    providers: sortRecordByKeys(providers),
  };
}

function loadBundledSnapshotSync(override?: PricingSnapshot): PricingSnapshot {
  if (override) {
    return normalizeSnapshot(override) ?? EMPTY_SNAPSHOT;
  }

  try {
    const url = new URL("../data/modelsdev-pricing.min.json", import.meta.url);
    const raw = readFileSync(url, "utf-8");
    return normalizeSnapshot(JSON.parse(raw)) ?? EMPTY_SNAPSHOT;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

export function getRuntimePricingSnapshotPath(runtimeDirs?: OpencodeRuntimeDirs): string {
  const dirs = runtimeDirs ?? getOpencodeRuntimeDirs();
  return join(dirs.cacheDir, "opencode-quota", RUNTIME_SNAPSHOT_FILENAME);
}

export function getRuntimePricingRefreshStatePath(runtimeDirs?: OpencodeRuntimeDirs): string {
  const dirs = runtimeDirs ?? getOpencodeRuntimeDirs();
  return join(dirs.cacheDir, "opencode-quota", RUNTIME_REFRESH_STATE_FILENAME);
}

function loadRuntimeSnapshotSync(runtimeDirs?: OpencodeRuntimeDirs): PricingSnapshot | null {
  const path = getRuntimePricingSnapshotPath(runtimeDirs);
  try {
    const raw = readFileSync(path, "utf-8");
    return normalizeSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function hasSnapshotData(snapshot: PricingSnapshot): boolean {
  return snapshot._meta.generatedAt > 0;
}

function chooseSnapshot(params?: {
  runtimeDirs?: OpencodeRuntimeDirs;
  bootstrapSnapshotOverride?: PricingSnapshot;
  selection?: PricingSnapshotSource;
}): { snapshot: PricingSnapshot; source: "runtime" | "bundled" | "empty" } {
  const bundled = loadBundledSnapshotSync(params?.bootstrapSnapshotOverride);
  const runtime = loadRuntimeSnapshotSync(params?.runtimeDirs);
  const selection = params?.selection ?? SNAPSHOT_SELECTION;

  if (selection === "bundled") {
    if (hasSnapshotData(bundled)) {
      return { snapshot: bundled, source: "bundled" };
    }
    return { snapshot: EMPTY_SNAPSHOT, source: "empty" };
  }

  if (selection === "runtime") {
    if (runtime) {
      return { snapshot: runtime, source: "runtime" };
    }
    if (hasSnapshotData(bundled)) {
      return { snapshot: bundled, source: "bundled" };
    }
    return { snapshot: EMPTY_SNAPSHOT, source: "empty" };
  }

  if (runtime && runtime._meta.generatedAt >= bundled._meta.generatedAt) {
    return { snapshot: runtime, source: "runtime" };
  }

  if (hasSnapshotData(bundled)) {
    return { snapshot: bundled, source: "bundled" };
  }

  return { snapshot: EMPTY_SNAPSHOT, source: "empty" };
}

function setSnapshot(snapshot: PricingSnapshot, source: "runtime" | "bundled" | "empty"): void {
  SNAPSHOT = snapshot;
  SNAPSHOT_SOURCE = source;
  MODEL_INDEX = null;
}

function applySnapshotSelection(params?: {
  runtimeDirs?: OpencodeRuntimeDirs;
  bootstrapSnapshotOverride?: PricingSnapshot;
  selection?: PricingSnapshotSource;
}): { snapshot: PricingSnapshot; source: "runtime" | "bundled" | "empty" } {
  const selected = chooseSnapshot(params);
  setSnapshot(selected.snapshot, selected.source);
  return selected;
}

function ensureLoaded(): PricingSnapshot {
  if (SNAPSHOT) return SNAPSHOT;
  const selected = applySnapshotSelection();
  return selected.snapshot;
}

function ensureModelIndex(): Map<string, string[]> {
  if (MODEL_INDEX) return MODEL_INDEX;
  const snap = ensureLoaded();
  const idx = new Map<string, string[]>();

  for (const providerId of Object.keys(snap.providers)) {
    const models = snap.providers[providerId] ?? {};
    for (const modelId of Object.keys(models)) {
      const existing = idx.get(modelId);
      if (existing) existing.push(providerId);
      else idx.set(modelId, [providerId]);
    }
  }

  MODEL_INDEX = idx;
  return idx;
}

function normalizeRefreshState(raw: unknown): PricingRefreshStateV1 | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const version = Number(obj.version);
  const updatedAt = Number(obj.updatedAt);
  if (version !== 1 || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;

  const out: PricingRefreshStateV1 = {
    version: 1,
    updatedAt: Math.trunc(updatedAt),
  };

  const lastAttemptAt = Number(obj.lastAttemptAt);
  const lastSuccessAt = Number(obj.lastSuccessAt);
  const lastFailureAt = Number(obj.lastFailureAt);

  if (Number.isFinite(lastAttemptAt) && lastAttemptAt > 0) out.lastAttemptAt = Math.trunc(lastAttemptAt);
  if (Number.isFinite(lastSuccessAt) && lastSuccessAt > 0) out.lastSuccessAt = Math.trunc(lastSuccessAt);
  if (Number.isFinite(lastFailureAt) && lastFailureAt > 0) out.lastFailureAt = Math.trunc(lastFailureAt);

  if (typeof obj.lastResult === "string") {
    const allowed = new Set(["success", "not_modified", "skipped_fresh", "skipped_throttled", "failed"]);
    if (allowed.has(obj.lastResult)) {
      out.lastResult = obj.lastResult as PricingRefreshStateV1["lastResult"];
    }
  }

  if (typeof obj.lastError === "string" && obj.lastError) out.lastError = obj.lastError;
  if (typeof obj.etag === "string" && obj.etag) out.etag = obj.etag;
  if (typeof obj.lastModified === "string" && obj.lastModified) out.lastModified = obj.lastModified;

  return out;
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(dir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");

  const safeRm = async (target: string): Promise<void> => {
    try {
      await rm(target, { force: true });
    } catch {
      // best-effort cleanup
    }
  };

  try {
    await rename(tmp, path);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    const shouldRetryAsReplace =
      code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "ENOTEMPTY";

    if (!shouldRetryAsReplace) {
      await safeRm(tmp);
      throw err;
    }

    await safeRm(path);
    await rename(tmp, path);
  }
}

async function readRefreshState(path: string): Promise<PricingRefreshStateV1 | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return normalizeRefreshState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function readPricingRefreshState(
  runtimeDirs?: OpencodeRuntimeDirs,
): Promise<PricingRefreshStateV1 | null> {
  return await readRefreshState(getRuntimePricingRefreshStatePath(runtimeDirs));
}

function makeDefaultRefreshState(nowMs: number): PricingRefreshStateV1 {
  return {
    version: 1,
    updatedAt: nowMs,
  };
}

function pickCostBuckets(rawCost: unknown): CostBuckets | null {
  const obj = asRecord(rawCost);
  if (!obj) return null;

  const picked: CostBuckets = {};
  for (const key of COST_KEYS) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      picked[key] = value;
    }
  }

  return Object.keys(picked).length > 0 ? picked : null;
}

function buildSnapshotFromApi(
  apiRaw: unknown,
  providerIDs: string[],
  generatedAt: number,
): PricingSnapshot {
  const api = asRecord(apiRaw) ?? {};
  const providers: Record<string, Record<string, CostBuckets>> = {};

  for (const providerID of providerIDs) {
    const providerNode = asRecord(api[providerID]);
    const models = asRecord(providerNode?.models);
    if (!models) continue;

    const pricedModels: Record<string, CostBuckets> = {};
    for (const modelID of Object.keys(models)) {
      const modelNode = asRecord(models[modelID]);
      const cost = pickCostBuckets(modelNode?.cost);
      if (cost) {
        pricedModels[modelID] = cost;
      }
    }

    if (Object.keys(pricedModels).length > 0) {
      providers[providerID] = sortRecordByKeys(pricedModels);
    }
  }

  const providerList = Object.keys(providers).sort((a, b) => a.localeCompare(b));

  return {
    _meta: {
      generatedAt,
      providers: providerList,
      source: SOURCE_URL,
      units: "USD per 1M tokens",
    },
    providers: sortRecordByKeys(providers),
  };
}

function countPricedModels(snapshot: PricingSnapshot): number {
  let total = 0;
  for (const models of Object.values(snapshot.providers)) {
    total += Object.keys(models).length;
  }
  return total;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchModelsDevSnapshot(params: {
  timeoutMs: number;
  state: PricingRefreshStateV1;
  fetchFn?: typeof fetch;
}): Promise<Response> {
  const headers = new Headers();
  if (params.state.etag) headers.set("If-None-Match", params.state.etag);
  if (params.state.lastModified) headers.set("If-Modified-Since", params.state.lastModified);

  if (!params.fetchFn) {
    return await fetchWithTimeout(SOURCE_URL, { headers }, params.timeoutMs);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    return await params.fetchFn(SOURCE_URL, {
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function maybeRefreshPricingSnapshot(
  opts: PricingRefreshOptions = {},
): Promise<PricingRefreshResult> {
  if (REFRESH_IN_FLIGHT) return REFRESH_IN_FLIGHT;

  REFRESH_IN_FLIGHT = (async (): Promise<PricingRefreshResult> => {
    const nowMs = opts.nowMs ?? Date.now();
    const policy = getPricingRefreshPolicy();
    const maxAgeMs = opts.maxAgeMs ?? policy.maxAgeMs;
    const minAttemptIntervalMs = opts.minAttemptIntervalMs ?? policy.minAttemptIntervalMs;
    const timeoutMs = opts.timeoutMs ?? policy.timeoutMs;
    const runtimeDirs = opts.runtimeDirs;
    const snapshotPath = getRuntimePricingSnapshotPath(runtimeDirs);
    const statePath = getRuntimePricingRefreshStatePath(runtimeDirs);
    const force = opts.force === true;
    const selection = opts.snapshotSelection ?? SNAPSHOT_SELECTION;
    const allowRefreshWhenSelectionBundled = opts.allowRefreshWhenSelectionBundled === true;

    const previousState = (await readRefreshState(statePath)) ?? makeDefaultRefreshState(nowMs);
    const runtimeSnapshotBeforeRefresh = loadRuntimeSnapshotSync(runtimeDirs);

    applySnapshotSelection({
      runtimeDirs,
      bootstrapSnapshotOverride: opts.bootstrapSnapshotOverride,
      selection,
    });

    if (selection === "bundled" && !allowRefreshWhenSelectionBundled) {
      return {
        attempted: false,
        updated: false,
        reason: "selection_bundled",
        state: {
          ...previousState,
          updatedAt: nowMs,
        },
      };
    }

    if (!force && PROCESS_REFRESH_CHECKED) {
      return {
        attempted: false,
        updated: false,
        reason: "already_checked_this_process",
        state: previousState,
      };
    }

    PROCESS_REFRESH_CHECKED = true;

    const health = getPricingSnapshotHealth({ nowMs, maxAgeMs });

    if (!force && !policy.enabled) {
      return {
        attempted: false,
        updated: false,
        reason: "disabled",
        state: {
          ...previousState,
          updatedAt: nowMs,
          lastResult: "skipped_fresh",
        },
      };
    }

    if (!force && !health.stale) {
      return {
        attempted: false,
        updated: false,
        reason: "fresh",
        state: {
          ...previousState,
          updatedAt: nowMs,
          lastResult: "skipped_fresh",
        },
      };
    }

    if (!force && previousState.lastAttemptAt && nowMs - previousState.lastAttemptAt < minAttemptIntervalMs) {
      return {
        attempted: false,
        updated: false,
        reason: "throttled",
        state: {
          ...previousState,
          updatedAt: nowMs,
          lastResult: "skipped_throttled",
        },
      };
    }

    const attemptingState: PricingRefreshStateV1 = {
      ...previousState,
      version: 1,
      updatedAt: nowMs,
      lastAttemptAt: nowMs,
    };

    try {
      const response = await fetchModelsDevSnapshot({
        timeoutMs,
        state: attemptingState,
        fetchFn: opts.fetchFn,
      });

      if (response.status === 304) {
        const baseSnapshot = runtimeSnapshotBeforeRefresh ?? ensureLoaded();
        const refreshedSnapshot: PricingSnapshot = {
          _meta: {
            ...baseSnapshot._meta,
            generatedAt: nowMs,
          },
          providers: baseSnapshot.providers,
        };
        await writeJsonAtomic(snapshotPath, refreshedSnapshot);
        applySnapshotSelection({
          runtimeDirs,
          bootstrapSnapshotOverride: opts.bootstrapSnapshotOverride,
          selection,
        });

        const nextState: PricingRefreshStateV1 = {
          ...attemptingState,
          updatedAt: nowMs,
          lastSuccessAt: nowMs,
          lastResult: "not_modified",
          lastError: undefined,
          etag: response.headers.get("etag") ?? attemptingState.etag,
          lastModified: response.headers.get("last-modified") ?? attemptingState.lastModified,
        };
        try {
          await writeJsonAtomic(statePath, nextState);
        } catch {
          // best effort; keep refreshed in-memory/runtime snapshot active
        }
        return {
          attempted: true,
          updated: true,
          state: nextState,
        };
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
      }

      const api = await response.json();
      const snapshot = buildSnapshotFromApi(
        api,
        opts.providerAllowlist ?? DEFAULT_MODELSDEV_PROVIDERS,
        nowMs,
      );
      if (countPricedModels(snapshot) === 0) {
        throw new Error("Refusing to persist empty pricing snapshot from models.dev");
      }

      await writeJsonAtomic(snapshotPath, snapshot);
      applySnapshotSelection({
        runtimeDirs,
        bootstrapSnapshotOverride: opts.bootstrapSnapshotOverride,
        selection,
      });

      const nextState: PricingRefreshStateV1 = {
        ...attemptingState,
        updatedAt: nowMs,
        lastSuccessAt: nowMs,
        lastResult: "success",
        lastError: undefined,
        etag: response.headers.get("etag") ?? attemptingState.etag,
        lastModified: response.headers.get("last-modified") ?? attemptingState.lastModified,
      };

      try {
        await writeJsonAtomic(statePath, nextState);
      } catch {
        // best effort; snapshot has already been updated
      }

      return {
        attempted: true,
        updated: true,
        state: nextState,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const nextState: PricingRefreshStateV1 = {
        ...attemptingState,
        updatedAt: nowMs,
        lastFailureAt: nowMs,
        lastResult: "failed",
        lastError: errorMessage,
      };

      try {
        await writeJsonAtomic(statePath, nextState);
      } catch {
        // best effort; report original fetch/refresh error
      }

      return {
        attempted: true,
        updated: false,
        error: errorMessage,
        state: nextState,
      };
    }
  })().finally(() => {
    REFRESH_IN_FLIGHT = null;
  });

  return REFRESH_IN_FLIGHT;
}

export function setPricingSnapshotSelection(selection: PricingSnapshotSource): void {
  if (SNAPSHOT_SELECTION === selection) return;
  SNAPSHOT_SELECTION = selection;
  SNAPSHOT = null;
  MODEL_INDEX = null;
}

export function getPricingSnapshotSelection(): PricingSnapshotSource {
  return SNAPSHOT_SELECTION;
}

export function getPricingSnapshotMeta(): PricingSnapshot["_meta"] {
  return ensureLoaded()._meta;
}

export function getPricingSnapshotSource(): "runtime" | "bundled" | "empty" {
  ensureLoaded();
  return SNAPSHOT_SOURCE;
}

export function getPricingSnapshotHealth(opts?: {
  nowMs?: number;
  maxAgeMs?: number;
}): PricingSnapshotHealth {
  const generatedAt = getPricingSnapshotMeta().generatedAt;
  const nowMs = opts?.nowMs ?? Date.now();
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
  const ageMs = Math.max(0, nowMs - generatedAt);
  return {
    generatedAt,
    ageMs,
    maxAgeMs,
    stale: ageMs > maxAgeMs,
  };
}

export function hasProvider(providerId: string): boolean {
  return !!ensureLoaded().providers[providerId];
}

export function isModelsDevProviderId(providerId: string): boolean {
  return hasProvider(providerId);
}

export function hasModel(providerId: string, modelId: string): boolean {
  const p = ensureLoaded().providers[providerId];
  if (!p) return false;
  return !!p[modelId];
}

/**
 * Infer the snapshot provider that owns a modelId.
 * Returns null when model is not found or is ambiguous across providers.
 */
export function inferProviderForModelId(modelId: string): string | null {
  const providers = listProvidersForModelId(modelId);
  if (!providers || providers.length !== 1) return null;
  return providers[0] ?? null;
}

export function getProviderModelCount(providerId: string): number {
  return Object.keys(ensureLoaded().providers[providerId] || {}).length;
}

export function listProviders(): string[] {
  return Object.keys(ensureLoaded().providers);
}

export function listModelsForProvider(providerId: string): string[] {
  return Object.keys(ensureLoaded().providers[providerId] ?? {});
}

export function listProvidersForModelId(modelId: string): string[] {
  const providers = ensureModelIndex().get(modelId) ?? [];
  return [...providers].sort((a, b) => a.localeCompare(b));
}

export function lookupCost(providerId: string, modelId: string): CostBuckets | null {
  const p = ensureLoaded().providers[providerId];
  if (!p) return null;
  const c = p[modelId];
  if (!c) return null;
  return c;
}

export function hasCost(providerId: string, modelId: string): boolean {
  return lookupCost(providerId, modelId) != null;
}

export function __resetPricingSnapshotForTests(): void {
  SNAPSHOT = null;
  SNAPSHOT_SOURCE = "bundled";
  SNAPSHOT_SELECTION = "auto";
  CONFIGURED_PRICING_SNAPSHOT_MAX_AGE_MS = DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
  MODEL_INDEX = null;
  REFRESH_IN_FLIGHT = null;
  PROCESS_REFRESH_CHECKED = false;
}
