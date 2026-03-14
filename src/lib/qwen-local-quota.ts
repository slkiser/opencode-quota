import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

import type { AlibabaCodingPlanTier } from "./types.js";
import { clampPercent } from "./format-utils.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

const QWEN_LOCAL_QUOTA_STATE_VERSION = 1 as const;
const ALIBABA_CODING_PLAN_STATE_VERSION = 1 as const;
const QWEN_FREE_DAILY_LIMIT = 1000;
const QWEN_FREE_RPM_LIMIT = 60;
const RPM_WINDOW_MS = 60_000;
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_QWEN_RECENT_TIMESTAMPS = 300;

export const ALIBABA_CODING_PLAN_LIMITS: Readonly<
  Record<AlibabaCodingPlanTier, { fiveHour: number; weekly: number; monthly: number }>
> = {
  lite: {
    fiveHour: 1200,
    weekly: 9000,
    monthly: 18000,
  },
  pro: {
    fiveHour: 6000,
    weekly: 45000,
    monthly: 90000,
  },
};

const MAX_ALIBABA_MONTHLY_LIMIT = Math.max(
  ...Object.values(ALIBABA_CODING_PLAN_LIMITS).map((limits) => limits.monthly),
);

export interface QwenLocalQuotaStateFileV1 {
  version: 1;
  utcDay: string;
  dayCount: number;
  recent: number[];
  updatedAt: number;
}

export interface AlibabaCodingPlanStateFileV1 {
  version: 1;
  recent: number[];
  updatedAt: number;
}

export interface QwenComputedQuota {
  day: {
    used: number;
    limit: number;
    percentRemaining: number;
    resetTimeIso: string;
  };
  rpm: {
    used: number;
    limit: number;
    percentRemaining: number;
    resetTimeIso?: string;
  };
}

interface RollingComputedQuotaWindow {
  used: number;
  limit: number;
  percentRemaining: number;
  resetTimeIso?: string;
}

export interface AlibabaCodingPlanComputedQuota {
  tier: AlibabaCodingPlanTier;
  fiveHour: RollingComputedQuotaWindow;
  weekly: RollingComputedQuotaWindow;
  monthly: RollingComputedQuotaWindow;
}

function utcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function nextUtcMidnightIso(tsMs: number): string {
  const now = new Date(tsMs);
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return new Date(nextMidnight).toISOString();
}

function defaultQwenState(nowMs: number): QwenLocalQuotaStateFileV1 {
  return {
    version: QWEN_LOCAL_QUOTA_STATE_VERSION,
    utcDay: utcDayKey(nowMs),
    dayCount: 0,
    recent: [],
    updatedAt: nowMs,
  };
}

function defaultAlibabaState(nowMs: number): AlibabaCodingPlanStateFileV1 {
  return {
    version: ALIBABA_CODING_PLAN_STATE_VERSION,
    recent: [],
    updatedAt: nowMs,
  };
}

function normalizeRecent(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0)
    .map((x) => Math.trunc(x));
}

function normalizeQwenState(raw: unknown, nowMs: number): QwenLocalQuotaStateFileV1 {
  if (!raw || typeof raw !== "object") {
    return defaultQwenState(nowMs);
  }

  const obj = raw as Partial<QwenLocalQuotaStateFileV1>;

  return {
    version: QWEN_LOCAL_QUOTA_STATE_VERSION,
    utcDay: typeof obj.utcDay === "string" && obj.utcDay.length === 10 ? obj.utcDay : utcDayKey(nowMs),
    dayCount:
      typeof obj.dayCount === "number" && Number.isFinite(obj.dayCount) && obj.dayCount >= 0
        ? Math.trunc(obj.dayCount)
        : 0,
    recent: normalizeRecent(obj.recent),
    updatedAt:
      typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
        ? Math.trunc(obj.updatedAt)
        : nowMs,
  };
}

function normalizeAlibabaState(raw: unknown, nowMs: number): AlibabaCodingPlanStateFileV1 {
  if (!raw || typeof raw !== "object") {
    return defaultAlibabaState(nowMs);
  }

  const obj = raw as Partial<AlibabaCodingPlanStateFileV1>;
  return {
    version: ALIBABA_CODING_PLAN_STATE_VERSION,
    recent: normalizeRecent(obj.recent),
    updatedAt:
      typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
        ? Math.trunc(obj.updatedAt)
        : nowMs,
  };
}

function applyUtcResetAndPrune(state: QwenLocalQuotaStateFileV1, nowMs: number): QwenLocalQuotaStateFileV1 {
  const today = utcDayKey(nowMs);
  const recentFloor = nowMs - RPM_WINDOW_MS;
  const recent = state.recent
    .filter((ts) => ts >= recentFloor && ts <= nowMs)
    .slice(-MAX_QWEN_RECENT_TIMESTAMPS);

  if (state.utcDay !== today) {
    return {
      version: QWEN_LOCAL_QUOTA_STATE_VERSION,
      utcDay: today,
      dayCount: 0,
      recent,
      updatedAt: nowMs,
    };
  }

  return {
    version: QWEN_LOCAL_QUOTA_STATE_VERSION,
    utcDay: today,
    dayCount: state.dayCount,
    recent,
    updatedAt: nowMs,
  };
}

function pruneAlibabaState(state: AlibabaCodingPlanStateFileV1, nowMs: number): AlibabaCodingPlanStateFileV1 {
  const recentFloor = nowMs - MONTHLY_WINDOW_MS;
  const recent = state.recent
    .filter((ts) => ts >= recentFloor && ts <= nowMs)
    .slice(-MAX_ALIBABA_MONTHLY_LIMIT);

  return {
    version: ALIBABA_CODING_PLAN_STATE_VERSION,
    recent,
    updatedAt: nowMs,
  };
}

function toPercentRemaining(used: number, limit: number): number {
  if (limit <= 0) return 0;
  const remaining = ((limit - used) / limit) * 100;
  return clampPercent(remaining);
}

async function readJsonState<T>(path: string, fallback: T, normalize: (raw: unknown) => T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return normalize(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

async function writeStateToDisk<T>(path: string, state: T): Promise<void> {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");

  const safeRm = async (target: string): Promise<void> => {
    try {
      await rm(target, { force: true });
    } catch {
      // best effort cleanup
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

function computeRollingWindow(params: {
  recent: number[];
  nowMs: number;
  windowMs: number;
  limit: number;
}): RollingComputedQuotaWindow {
  const windowFloor = params.nowMs - params.windowMs;
  const matches = params.recent.filter((ts) => ts >= windowFloor && ts <= params.nowMs);
  const oldest = matches.length > 0 ? Math.min(...matches) : undefined;

  return {
    used: matches.length,
    limit: params.limit,
    percentRemaining: toPercentRemaining(matches.length, params.limit),
    resetTimeIso: typeof oldest === "number" ? new Date(oldest + params.windowMs).toISOString() : undefined,
  };
}

export function getQwenLocalQuotaPath(): string {
  const { stateDir } = getOpencodeRuntimeDirs();
  return join(stateDir, "opencode-quota", "qwen-local-quota.json");
}

export function getAlibabaCodingPlanQuotaPath(): string {
  const { stateDir } = getOpencodeRuntimeDirs();
  return join(stateDir, "opencode-quota", "alibaba-coding-plan-local-quota.json");
}

export async function readQwenLocalQuotaState(params?: { nowMs?: number }): Promise<QwenLocalQuotaStateFileV1> {
  const nowMs = params?.nowMs ?? Date.now();
  const path = getQwenLocalQuotaPath();
  const state = await readJsonState(path, defaultQwenState(nowMs), (raw) => normalizeQwenState(raw, nowMs));
  return applyUtcResetAndPrune(state, nowMs);
}

export async function readAlibabaCodingPlanQuotaState(params?: {
  nowMs?: number;
}): Promise<AlibabaCodingPlanStateFileV1> {
  const nowMs = params?.nowMs ?? Date.now();
  const path = getAlibabaCodingPlanQuotaPath();
  const state = await readJsonState(path, defaultAlibabaState(nowMs), (raw) => normalizeAlibabaState(raw, nowMs));
  return pruneAlibabaState(state, nowMs);
}

export async function recordQwenCompletion(params?: { atMs?: number }): Promise<QwenLocalQuotaStateFileV1> {
  const nowMs = params?.atMs ?? Date.now();
  const path = getQwenLocalQuotaPath();
  const loaded = await readJsonState(path, defaultQwenState(nowMs), (raw) => normalizeQwenState(raw, nowMs));
  const state = applyUtcResetAndPrune(loaded, nowMs);

  const next: QwenLocalQuotaStateFileV1 = {
    ...state,
    dayCount: state.dayCount + 1,
    recent: [...state.recent, nowMs].slice(-MAX_QWEN_RECENT_TIMESTAMPS),
    updatedAt: nowMs,
  };

  await writeStateToDisk(path, next);
  return next;
}

export async function recordAlibabaCodingPlanCompletion(params?: {
  atMs?: number;
}): Promise<AlibabaCodingPlanStateFileV1> {
  const nowMs = params?.atMs ?? Date.now();
  const path = getAlibabaCodingPlanQuotaPath();
  const loaded = await readJsonState(path, defaultAlibabaState(nowMs), (raw) => normalizeAlibabaState(raw, nowMs));
  const state = pruneAlibabaState(loaded, nowMs);

  const next: AlibabaCodingPlanStateFileV1 = {
    ...state,
    recent: [...state.recent, nowMs].slice(-MAX_ALIBABA_MONTHLY_LIMIT),
    updatedAt: nowMs,
  };

  await writeStateToDisk(path, next);
  return next;
}

export function computeQwenQuota(params: {
  state: QwenLocalQuotaStateFileV1;
  nowMs?: number;
  dayLimit?: number;
  rpmLimit?: number;
}): QwenComputedQuota {
  const nowMs = params.nowMs ?? Date.now();
  const dayLimit = params.dayLimit ?? QWEN_FREE_DAILY_LIMIT;
  const rpmLimit = params.rpmLimit ?? QWEN_FREE_RPM_LIMIT;
  const state = applyUtcResetAndPrune(params.state, nowMs);

  const dayUsed = Math.max(0, Math.trunc(state.dayCount));
  const rpmUsed = state.recent.length;
  const oldestRecent = state.recent.length > 0 ? Math.min(...state.recent) : undefined;

  return {
    day: {
      used: dayUsed,
      limit: dayLimit,
      percentRemaining: toPercentRemaining(dayUsed, dayLimit),
      resetTimeIso: nextUtcMidnightIso(nowMs),
    },
    rpm: {
      used: rpmUsed,
      limit: rpmLimit,
      percentRemaining: toPercentRemaining(rpmUsed, rpmLimit),
      resetTimeIso:
        typeof oldestRecent === "number" ? new Date(oldestRecent + RPM_WINDOW_MS).toISOString() : undefined,
    },
  };
}

export function computeAlibabaCodingPlanQuota(params: {
  state: AlibabaCodingPlanStateFileV1;
  tier: AlibabaCodingPlanTier;
  nowMs?: number;
  limits?: { fiveHour: number; weekly: number; monthly: number };
}): AlibabaCodingPlanComputedQuota {
  const nowMs = params.nowMs ?? Date.now();
  const state = pruneAlibabaState(params.state, nowMs);
  const limits = params.limits ?? ALIBABA_CODING_PLAN_LIMITS[params.tier];

  return {
    tier: params.tier,
    fiveHour: computeRollingWindow({
      recent: state.recent,
      nowMs,
      windowMs: FIVE_HOUR_WINDOW_MS,
      limit: limits.fiveHour,
    }),
    weekly: computeRollingWindow({
      recent: state.recent,
      nowMs,
      windowMs: WEEKLY_WINDOW_MS,
      limit: limits.weekly,
    }),
    monthly: computeRollingWindow({
      recent: state.recent,
      nowMs,
      windowMs: MONTHLY_WINDOW_MS,
      limit: limits.monthly,
    }),
  };
}
