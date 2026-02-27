import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { clampPercent } from "./format-utils.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

const QWEN_LOCAL_QUOTA_STATE_VERSION = 1 as const;
const QWEN_DAILY_LIMIT = 1000;
const QWEN_RPM_LIMIT = 60;
const RPM_WINDOW_MS = 60_000;
const MAX_RECENT_TIMESTAMPS = 300;

export interface QwenLocalQuotaStateFileV1 {
  version: 1;
  utcDay: string;
  dayCount: number;
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

function utcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function nextUtcMidnightIso(tsMs: number): string {
  const now = new Date(tsMs);
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return new Date(nextMidnight).toISOString();
}

function defaultState(nowMs: number): QwenLocalQuotaStateFileV1 {
  return {
    version: QWEN_LOCAL_QUOTA_STATE_VERSION,
    utcDay: utcDayKey(nowMs),
    dayCount: 0,
    recent: [],
    updatedAt: nowMs,
  };
}

function normalizeState(raw: unknown, nowMs: number): QwenLocalQuotaStateFileV1 {
  if (!raw || typeof raw !== "object") {
    return defaultState(nowMs);
  }

  const obj = raw as Partial<QwenLocalQuotaStateFileV1>;
  const recentRaw = Array.isArray(obj.recent) ? obj.recent : [];
  const recent = recentRaw
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0)
    .map((x) => Math.trunc(x));

  return {
    version: QWEN_LOCAL_QUOTA_STATE_VERSION,
    utcDay: typeof obj.utcDay === "string" && obj.utcDay.length === 10 ? obj.utcDay : utcDayKey(nowMs),
    dayCount:
      typeof obj.dayCount === "number" && Number.isFinite(obj.dayCount) && obj.dayCount >= 0
        ? Math.trunc(obj.dayCount)
        : 0,
    recent,
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
    .slice(-MAX_RECENT_TIMESTAMPS);

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

function toPercentRemaining(used: number, limit: number): number {
  if (limit <= 0) return 0;
  const remaining = ((limit - used) / limit) * 100;
  return clampPercent(remaining);
}

async function readStateFromDisk(path: string, nowMs: number): Promise<QwenLocalQuotaStateFileV1> {
  try {
    const raw = await readFile(path, "utf-8");
    return normalizeState(JSON.parse(raw), nowMs);
  } catch {
    return defaultState(nowMs);
  }
}

async function writeStateToDisk(path: string, state: QwenLocalQuotaStateFileV1): Promise<void> {
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

export function getQwenLocalQuotaPath(): string {
  const { stateDir } = getOpencodeRuntimeDirs();
  return join(stateDir, "opencode-quota", "qwen-local-quota.json");
}

export async function readQwenLocalQuotaState(params?: { nowMs?: number }): Promise<QwenLocalQuotaStateFileV1> {
  const nowMs = params?.nowMs ?? Date.now();
  const path = getQwenLocalQuotaPath();
  const state = await readStateFromDisk(path, nowMs);
  return applyUtcResetAndPrune(state, nowMs);
}

export async function recordQwenCompletion(params?: { atMs?: number }): Promise<QwenLocalQuotaStateFileV1> {
  const nowMs = params?.atMs ?? Date.now();
  const path = getQwenLocalQuotaPath();
  const loaded = await readStateFromDisk(path, nowMs);
  const state = applyUtcResetAndPrune(loaded, nowMs);

  const next: QwenLocalQuotaStateFileV1 = {
    ...state,
    dayCount: state.dayCount + 1,
    recent: [...state.recent, nowMs].slice(-MAX_RECENT_TIMESTAMPS),
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
  const dayLimit = params.dayLimit ?? QWEN_DAILY_LIMIT;
  const rpmLimit = params.rpmLimit ?? QWEN_RPM_LIMIT;
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
