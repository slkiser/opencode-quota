/**
 * The models.dev price list, one per process: which list is in use (the one shipped in this
 * package or the one downloaded into OpenCode's cache folder), price lookups, downloads, and a
 * description for the status report. It follows the pricing settings `usePricingSettings` gives.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Settings } from "../settings/schema.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { fetchWithTimeout } from "./http.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

type PricingSettings = Settings["providers"]["pricing"];

/** Which price list reports use: "auto" (runtime when valid, else bundled), or one of them. */
export type PricingSnapshotSource = PricingSettings["source"];

const SOURCE_URL = "https://models.dev/api.json";
const UNITS = "USD per 1M tokens";
const DEFAULT_MODELSDEV_PROVIDERS = ["anthropic", "google", "moonshotai", "openai", "xai", "zai"];
/** The prices read from models.dev; a saved snapshot may also carry `reasoning`. */
const API_COST_KEYS = ["input", "output", "cache_read", "cache_write"] as const;
const SNAPSHOT_COST_KEYS = [...API_COST_KEYS, "reasoning"] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Without pricing settings: the settings' defaults, the "auto" list due after 7 days. */
const DEFAULT_SETTINGS: PricingSettings = { source: "auto", autoRefreshDays: 7 };
const REFRESH_MIN_ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 6_000;
/** How long a check waits for a due download before it goes on with the list in use. */
const REFRESH_WAIT_MS = 750;

export type CostBuckets = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};

type PricingSnapshot = {
  _meta: {
    source: string;
    generatedAt: number;
    providers: string[];
    units: string;
  };
  providers: Record<string, Record<string, CostBuckets>>;
};

interface PricingRefreshStateV1 {
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

/** `reason` says why a refresh did not download; `error` why a download failed. */
type RefreshResult = { updated: boolean; reason?: string; error?: string };

type ListSource = "runtime" | "bundled" | "empty";
type LoadedList = {
  selection: PricingSnapshotSource;
  snapshot: PricingSnapshot;
  source: ListSource;
};

/** Everything the status report and `status --json` say about the price list. */
export interface PriceListDescription {
  /** The settings' choice. */
  selection: PricingSnapshotSource;
  /** The list in use: downloaded, shipped, or none readable. */
  source: ListSource;
  meta: PricingSnapshot["_meta"];
  /** The list's age against the days the settings allow. */
  health: { ageMs: number; maxAgeMs: number; stale: boolean };
  paths: { snapshot: string; refreshState: string };
  refreshState: PricingRefreshStateV1 | null;
  /** The ids of the list shipped in this package, never a downloaded one. */
  bundledProviderIds: ReadonlySet<string>;
  /** The model ids of the shipped list, under any provider. */
  bundledModelIds: ReadonlySet<string>;
}

const EMPTY_SNAPSHOT: PricingSnapshot = {
  _meta: { source: "none", generatedAt: 0, providers: [], units: UNITS },
  providers: {},
};
const REFRESH_RESULTS = new Set([
  "success",
  "not_modified",
  "skipped_fresh",
  "skipped_throttled",
  "failed",
]);

/** The bound settings, oldest first; the last one still bound is followed. */
const SETTINGS_BINDINGS: Array<{ current: () => PricingSettings }> = [];
let LOADED: LoadedList | null = null;
/** The refresh that runs now, and whether it was forced. */
let REFRESH_IN_FLIGHT: { force: boolean; result: Promise<RefreshResult> } | null = null;
let PROCESS_REFRESH_CHECKED = false;
let BUNDLED_IDS: Pick<PriceListDescription, "bundledProviderIds" | "bundledModelIds"> | null = null;

/**
 * Follows the pricing settings `current` gives, read each time they matter (which list and how
 * many days old it may get before a download), until the returned function unbinds them.
 * Unbinding removes only this binding; the last binding still bound wins, else "auto", 7 days.
 */
export function usePricingSettings(current: () => PricingSettings): () => void {
  const binding = { current };
  SETTINGS_BINDINGS.push(binding);
  return () => {
    const index = SETTINGS_BINDINGS.indexOf(binding);
    if (index !== -1) SETTINGS_BINDINGS.splice(index, 1);
  };
}

function pricingSettings(): PricingSettings {
  return SETTINGS_BINDINGS.at(-1)?.current() ?? DEFAULT_SETTINGS;
}

/** An object or an array (an array's entries are keyed by position). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Sorted by key, so a saved snapshot reads and diffs in a stable order. */
function sortByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** The finite prices among `keys`; null when there are none. */
function pickCosts(raw: unknown, keys: readonly (keyof CostBuckets)[]): CostBuckets | null {
  const record = asRecord(raw);
  const picked: CostBuckets = {};
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) picked[key] = value;
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

function withProviders(
  meta: Omit<PricingSnapshot["_meta"], "providers">,
  providers: PricingSnapshot["providers"],
): PricingSnapshot {
  const sorted = sortByKey(providers);
  return { _meta: { ...meta, providers: Object.keys(sorted) }, providers: sorted };
}

/** A snapshot of the providers with at least one priced model. */
function makeSnapshot(
  meta: Omit<PricingSnapshot["_meta"], "providers">,
  modelsByProvider: Array<[providerId: string, models: unknown]>,
  costOf: (model: unknown) => CostBuckets | null,
): PricingSnapshot {
  const providers: PricingSnapshot["providers"] = {};
  for (const [providerId, modelsRaw] of modelsByProvider) {
    const models: Record<string, CostBuckets> = {};
    for (const [modelId, model] of Object.entries(asRecord(modelsRaw) ?? {})) {
      const cost = costOf(model);
      if (cost) models[modelId] = cost;
    }
    if (Object.keys(models).length > 0) providers[providerId] = sortByKey(models);
  }
  return withProviders(meta, providers);
}

/** A saved snapshot (bundled or runtime); null when it has no valid date. */
function normalizeSnapshot(raw: unknown): PricingSnapshot | null {
  const meta = asRecord(asRecord(raw)?._meta);
  const providers = asRecord(asRecord(raw)?.providers);
  const generatedAt = Number(meta?.generatedAt);
  if (!meta || !providers || !Number.isFinite(generatedAt) || generatedAt <= 0) return null;
  return makeSnapshot(
    {
      source: typeof meta.source === "string" && meta.source ? meta.source : SOURCE_URL,
      generatedAt: Math.trunc(generatedAt),
      units: typeof meta.units === "string" && meta.units ? meta.units : UNITS,
    },
    Object.entries(providers),
    (model) => pickCosts(model, SNAPSHOT_COST_KEYS),
  );
}

function buildSnapshotFromApi(apiRaw: unknown, generatedAt: number): PricingSnapshot {
  const api = asRecord(apiRaw) ?? {};
  return makeSnapshot(
    { source: SOURCE_URL, generatedAt, units: UNITS },
    DEFAULT_MODELSDEV_PROVIDERS.map((providerID) => [
      providerID,
      asRecord(api[providerID])?.models,
    ]),
    (model) => pickCosts(asRecord(model)?.cost, API_COST_KEYS),
  );
}

/**
 * models.dev drops retired models from its list. Keep their last known price so
 * older usage still gets a cost. `current` wins, then `previous` in the order given.
 * Callers list the user's runtime snapshot before the bundled one: its prices come
 * from the user's own last download, while the bundled file's date only says when
 * the file was rewritten, not when a kept model's price was last seen.
 */
function keepRetiredModels(
  current: PricingSnapshot,
  previous: Array<PricingSnapshot | null>,
): PricingSnapshot {
  const providers = { ...current.providers };
  for (const providerID of DEFAULT_MODELSDEV_PROVIDERS) {
    const models = { ...providers[providerID] };
    for (const snapshot of previous) {
      for (const [modelID, cost] of Object.entries(snapshot?.providers[providerID] ?? {})) {
        models[modelID] ??= cost;
      }
    }
    if (Object.keys(models).length > 0) providers[providerID] = sortByKey(models);
  }
  return withProviders(current._meta, providers);
}

function readSnapshotFile(path: string | URL): PricingSnapshot | null {
  try {
    return normalizeSnapshot(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function loadBundledSnapshot(): PricingSnapshot {
  const bundled = readSnapshotFile(new URL("../data/modelsdev-pricing.min.json", import.meta.url));
  return bundled ?? EMPTY_SNAPSHOT;
}

/** Where downloads go: OpenCode's cache folder. */
function runtimePaths(): PriceListDescription["paths"] {
  const dir = join(getOpencodeRuntimeDirs().cacheDir, "opencode-quota");
  return {
    snapshot: join(dir, "modelsdev-pricing.runtime.min.json"),
    refreshState: join(dir, "modelsdev-pricing.refresh-state.json"),
  };
}

/** "bundled" pins the shipped file, "runtime" prefers the downloaded one, "auto" takes the newer. */
function chooseList(selection: PricingSnapshotSource): LoadedList {
  const bundled = loadBundledSnapshot();
  const runtime = selection === "bundled" ? null : readSnapshotFile(runtimePaths().snapshot);
  if (
    runtime &&
    (selection === "runtime" || runtime._meta.generatedAt >= bundled._meta.generatedAt)
  ) {
    // A runtime snapshot saved by an older version may lack models that models.dev stopped
    // listing; the bundled file fills them until its next refresh.
    return { selection, snapshot: keepRetiredModels(runtime, [bundled]), source: "runtime" };
  }
  const source = bundled === EMPTY_SNAPSHOT ? "empty" : "bundled";
  return { selection, snapshot: bundled, source };
}

/** The list the settings choose, read again when the choice changes. */
function activeList(): LoadedList {
  const { source } = pricingSettings();
  if (LOADED?.selection !== source) LOADED = chooseList(source);
  return LOADED;
}

/** Days after which the list counts as stale; not a positive number means 7 days. */
function maxAgeMs(): number {
  const days = pricingSettings().autoRefreshDays;
  return Number.isFinite(days) && days > 0
    ? Math.floor(days * MS_PER_DAY)
    : DEFAULT_SETTINGS.autoRefreshDays * MS_PER_DAY;
}

function listHealth(generatedAt: number, nowMs: number): PriceListDescription["health"] {
  const ageMs = Math.max(0, nowMs - generatedAt);
  const maxAge = maxAgeMs();
  return { ageMs, maxAgeMs: maxAge, stale: ageMs > maxAge };
}

function normalizeRefreshState(raw: unknown): PricingRefreshStateV1 | null {
  const record = asRecord(raw);
  const updatedAt = Number(record?.updatedAt);
  if (!record || Number(record.version) !== 1 || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return null;
  }
  const state: PricingRefreshStateV1 = { version: 1, updatedAt: Math.trunc(updatedAt) };
  for (const key of ["lastAttemptAt", "lastSuccessAt", "lastFailureAt"] as const) {
    const at = Number(record[key]);
    if (Number.isFinite(at) && at > 0) state[key] = Math.trunc(at);
  }
  if (typeof record.lastResult === "string" && REFRESH_RESULTS.has(record.lastResult)) {
    state.lastResult = record.lastResult as PricingRefreshStateV1["lastResult"];
  }
  for (const key of ["lastError", "etag", "lastModified"] as const) {
    const text = record[key];
    if (typeof text === "string" && text) state[key] = text;
  }
  return state;
}

async function readRefreshState(path: string): Promise<PricingRefreshStateV1 | null> {
  try {
    return normalizeRefreshState(JSON.parse(await readFile(path, "utf-8")));
  } catch {
    return null;
  }
}

type ModelsDevFetchResult = {
  kind: "not_modified" | "success";
  api?: unknown;
  etag?: string;
  lastModified?: string;
};

async function fetchModelsDev(state: PricingRefreshStateV1): Promise<ModelsDevFetchResult> {
  const headers = new Headers();
  if (state.etag) headers.set("If-None-Match", state.etag);
  if (state.lastModified) headers.set("If-Modified-Since", state.lastModified);

  return await fetchWithTimeout(SOURCE_URL, {
    request: { headers },
    timeoutMs: REFRESH_TIMEOUT_MS,
    consume: async (response): Promise<ModelsDevFetchResult> => {
      const etag = response.headers.get("etag") ?? undefined;
      const lastModified = response.headers.get("last-modified") ?? undefined;
      if (response.status === 304) return { kind: "not_modified", etag, lastModified };
      if (!response.ok) {
        throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
      }
      return { kind: "success", api: await response.json(), etag, lastModified };
    },
  });
}

/**
 * One refresh at a time: a call while one runs gets that one's result. A forced call never takes
 * an automatic one's result: it waits for that one to end, then downloads.
 */
async function refreshOnce(force: boolean): Promise<RefreshResult> {
  while (force && REFRESH_IN_FLIGHT && !REFRESH_IN_FLIGHT.force) {
    await REFRESH_IN_FLIGHT.result.catch(() => undefined);
  }
  REFRESH_IN_FLIGHT ??= {
    force,
    result: refresh(force).finally(() => {
      REFRESH_IN_FLIGHT = null;
    }),
  };
  return REFRESH_IN_FLIGHT.result;
}

/**
 * Reads the lists again (a download by another process counts), then downloads new models.dev
 * prices when the list in use is stale: once per process, at most every 6 hours across processes
 * (the refresh state file remembers the last attempt), never with the settings on the bundled
 * list. `force` downloads whatever the age, also for the bundled list. A failure keeps the list
 * in use.
 */
async function refresh(force: boolean): Promise<RefreshResult> {
  const nowMs = Date.now();
  const selection = pricingSettings().source;
  const paths = runtimePaths();
  const previousState = (await readRefreshState(paths.refreshState)) ?? {
    version: 1,
    updatedAt: nowMs,
  };
  const runtimeBefore = readSnapshotFile(paths.snapshot);
  const bundled = loadBundledSnapshot();
  const list = chooseList(selection);
  LOADED = list;

  if (selection === "bundled" && !force) return { updated: false, reason: "selection_bundled" };
  if (!force && PROCESS_REFRESH_CHECKED) {
    return { updated: false, reason: "already_checked_this_process" };
  }
  PROCESS_REFRESH_CHECKED = true;
  if (!force && !listHealth(list.snapshot._meta.generatedAt, nowMs).stale) {
    return { updated: false, reason: "fresh" };
  }
  const lastAttemptAt = previousState.lastAttemptAt;
  if (!force && lastAttemptAt && nowMs - lastAttemptAt < REFRESH_MIN_ATTEMPT_INTERVAL_MS) {
    return { updated: false, reason: "throttled" };
  }

  const attempting: PricingRefreshStateV1 = {
    ...previousState,
    version: 1,
    updatedAt: nowMs,
    lastAttemptAt: nowMs,
  };
  let next: PricingRefreshStateV1;
  try {
    const fetched = await fetchModelsDev(attempting);
    let snapshot: PricingSnapshot;
    if (fetched.kind === "not_modified") {
      // The same prices, confirmed now; also heals snapshots saved before retired models were kept.
      const base = runtimeBefore ?? list.snapshot;
      const confirmed = { _meta: { ...base._meta, generatedAt: nowMs }, providers: base.providers };
      snapshot = keepRetiredModels(confirmed, [bundled]);
    } else {
      const fresh = buildSnapshotFromApi(fetched.api, nowMs);
      if (Object.keys(fresh.providers).length === 0) {
        throw new Error("Refusing to persist empty pricing snapshot from models.dev");
      }
      snapshot = keepRetiredModels(fresh, [runtimeBefore, bundled]);
    }
    await writeJsonAtomic(paths.snapshot, snapshot, { trailingNewline: true });
    LOADED = chooseList(selection);
    next = {
      ...attempting,
      lastSuccessAt: nowMs,
      lastResult: fetched.kind,
      lastError: undefined,
      etag: fetched.etag ?? attempting.etag,
      lastModified: fetched.lastModified ?? attempting.lastModified,
    };
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error);
    next = { ...attempting, lastFailureAt: nowMs, lastResult: "failed", lastError };
  }

  // Best effort: the list in use and the result stay right without the state file.
  await writeJsonAtomic(paths.refreshState, next, { trailingNewline: true }).catch(() => {});
  return next.lastResult === "failed"
    ? { updated: false, error: next.lastError }
    : { updated: true };
}

/**
 * Starts a models.dev download when the list is due for one (see `refresh`) and waits for it at
 * most 0.75 s; a slower download goes on in the background. The wait's timer ends with the wait,
 * so it never keeps the process running.
 */
export async function refreshPricesIfDue(): Promise<void> {
  const refreshed = refreshOnce(false).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REFRESH_WAIT_MS);
  });
  await Promise.race([refreshed, waited]);
  clearTimeout(timer);
}

/**
 * Downloads the price list from models.dev now, whatever its age. With the settings on the
 * bundled list, the download is kept but lookups keep using the bundled one.
 */
export async function downloadPrices(): Promise<{ ok: boolean; message: string }> {
  const { source } = pricingSettings();
  const result = await refreshOnce(true);
  if (!result.updated) {
    const reason = result.error ?? result.reason ?? "unknown reason";
    return { ok: false, message: `Couldn't download new prices: ${reason}.` };
  }
  if (source === "bundled") {
    return {
      ok: true,
      message:
        "Downloaded new prices. Usage keeps the built-in prices: the pricing source setting is bundled.",
    };
  }
  return { ok: true, message: "Downloaded new prices from models.dev." };
}

/** The list lookups use now: the settings' choice, the list it gave and its header. */
export function activePriceList(): Pick<PriceListDescription, "selection" | "source" | "meta"> {
  const { selection, source, snapshot } = activeList();
  return { selection, source, meta: snapshot._meta };
}

/** The ids of the list shipped in this package (read once). */
function bundledIds(): Pick<PriceListDescription, "bundledProviderIds" | "bundledModelIds"> {
  if (!BUNDLED_IDS) {
    const { providers } = loadBundledSnapshot();
    BUNDLED_IDS = {
      bundledProviderIds: new Set(Object.keys(providers)),
      bundledModelIds: new Set(Object.values(providers).flatMap((models) => Object.keys(models))),
    };
  }
  return BUNDLED_IDS;
}

export async function describePriceList(): Promise<PriceListDescription> {
  const active = activePriceList();
  const paths = runtimePaths();
  return {
    ...active,
    health: listHealth(active.meta.generatedAt, Date.now()),
    paths,
    refreshState: await readRefreshState(paths.refreshState),
    ...bundledIds(),
  };
}

/** A model's prices; own keys only, so "constructor" or "__proto__" is never a model. */
export function lookupCost(providerId: string, modelId: string): CostBuckets | null {
  const { providers } = activeList().snapshot;
  if (!Object.hasOwn(providers, providerId)) return null;
  const models = providers[providerId]!;
  return Object.hasOwn(models, modelId) ? models[modelId]! : null;
}

export function hasProvider(providerId: string): boolean {
  return Object.hasOwn(activeList().snapshot.providers, providerId);
}

export function hasModel(providerId: string, modelId: string): boolean {
  return lookupCost(providerId, modelId) !== null;
}

export function listProvidersForModelId(modelId: string): string[] {
  const { providers } = activeList().snapshot;
  return Object.keys(providers)
    .filter((providerId) => Object.hasOwn(providers[providerId] ?? {}, modelId))
    .sort((a, b) => a.localeCompare(b));
}

export function __resetPricingSnapshotForTests(): void {
  SETTINGS_BINDINGS.length = 0;
  LOADED = null;
  REFRESH_IN_FLIGHT = null;
  PROCESS_REFRESH_CHECKED = false;
}
