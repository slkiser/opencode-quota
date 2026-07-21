import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import type { OpenCodeMessage } from "./opencode-storage.js";
import { iterCompletedAssistantMessages } from "./opencode-storage.js";
import type { AlibabaCodingPlanTier } from "./types.js";
import { clampPercent } from "./format-utils.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

export const QWEN_LOCAL_QUOTA_STATE_VERSION = 1 as const;
export const ALIBABA_CODING_PLAN_STATE_VERSION = 1 as const;
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
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
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

function applyUtcResetAndPrune(
  state: QwenLocalQuotaStateFileV1,
  nowMs: number,
): QwenLocalQuotaStateFileV1 {
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

function pruneAlibabaState(
  state: AlibabaCodingPlanStateFileV1,
  nowMs: number,
): AlibabaCodingPlanStateFileV1 {
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

function oldestTimestamp(timestamps: readonly number[]): number | undefined {
  let oldest: number | undefined;
  for (const timestamp of timestamps) {
    if (oldest === undefined || timestamp < oldest) oldest = timestamp;
  }
  return oldest;
}

function computeRollingWindow(params: {
  recent: number[];
  nowMs: number;
  windowMs: number;
  limit: number;
}): RollingComputedQuotaWindow {
  const windowFloor = params.nowMs - params.windowMs;
  const matches = params.recent.filter((ts) => ts >= windowFloor && ts <= params.nowMs);
  const oldest = oldestTimestamp(matches);

  return {
    used: matches.length,
    limit: params.limit,
    percentRemaining: toPercentRemaining(matches.length, params.limit),
    resetTimeIso:
      typeof oldest === "number" ? new Date(oldest + params.windowMs).toISOString() : undefined,
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

interface MaintainedLocalQuotaDependencies {
  nowMs?: number;
  readMessages?: (params: {
    completedSinceMs: number;
    completedUntilMs: number;
  }) => Promise<OpenCodeMessage[]>;
  writeState?: (
    path: string,
    state: QwenLocalQuotaStateFileV1 | AlibabaCodingPlanStateFileV1,
  ) => Promise<void>;
}

function completedTimestamp(message: OpenCodeMessage): number | null {
  const value = message.time?.completed;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function completedTimestamps(params: {
  messages: readonly OpenCodeMessage[];
  providerIds: readonly string[];
  sinceMs: number;
  untilMs: number;
}): number[] {
  const byId = new Map<string, number>();
  for (const message of params.messages) {
    if (
      message.role !== "assistant" ||
      !message.providerID ||
      !params.providerIds.includes(message.providerID) ||
      !message.id
    ) {
      continue;
    }
    const atMs = completedTimestamp(message);
    if (atMs === null || atMs < params.sinceMs || atMs > params.untilMs) continue;
    byId.set(message.id, atMs);
  }
  return [...byId.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .map(([, atMs]) => atMs);
}

async function readCompletedMessages(
  dependencies: MaintainedLocalQuotaDependencies,
  completedSinceMs: number,
  completedUntilMs: number,
): Promise<OpenCodeMessage[]> {
  const readMessages =
    dependencies.readMessages ??
    ((params) =>
      iterCompletedAssistantMessages({
        completedSinceMs: params.completedSinceMs,
        completedUntilMs: params.completedUntilMs,
      }));
  return readMessages({ completedSinceMs, completedUntilMs });
}

async function writeDerivedState(
  path: string,
  state: QwenLocalQuotaStateFileV1 | AlibabaCodingPlanStateFileV1,
  dependencies: MaintainedLocalQuotaDependencies,
): Promise<void> {
  const writeState =
    dependencies.writeState ??
    ((target, value) => writeJsonAtomic(target, value, { trailingNewline: true }));
  await writeState(path, state);
}

export async function readQwenLocalQuotaState(
  dependencies: MaintainedLocalQuotaDependencies = {},
): Promise<QwenLocalQuotaStateFileV1> {
  const nowMs = dependencies.nowMs ?? Date.now();
  const sinceMs = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  const timestamps = completedTimestamps({
    messages: await readCompletedMessages(dependencies, sinceMs, nowMs),
    providerIds: ["qwen-code"],
    sinceMs,
    untilMs: nowMs,
  });
  const state: QwenLocalQuotaStateFileV1 = {
    ...defaultQwenState(nowMs),
    dayCount: timestamps.length,
    recent: timestamps
      .filter((timestamp) => timestamp >= nowMs - RPM_WINDOW_MS)
      .slice(-MAX_QWEN_RECENT_TIMESTAMPS),
  };
  await writeDerivedState(getQwenLocalQuotaPath(), state, dependencies);
  return state;
}

export async function readAlibabaCodingPlanQuotaState(
  dependencies: MaintainedLocalQuotaDependencies = {},
): Promise<AlibabaCodingPlanStateFileV1> {
  const nowMs = dependencies.nowMs ?? Date.now();
  const sinceMs = nowMs - MONTHLY_WINDOW_MS;
  const state: AlibabaCodingPlanStateFileV1 = {
    ...defaultAlibabaState(nowMs),
    recent: completedTimestamps({
      messages: await readCompletedMessages(dependencies, sinceMs, nowMs),
      providerIds: ["alibaba-coding-plan", "alibaba"],
      sinceMs,
      untilMs: nowMs,
    }).slice(-MAX_ALIBABA_MONTHLY_LIMIT),
  };
  await writeDerivedState(getAlibabaCodingPlanQuotaPath(), state, dependencies);
  return state;
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
  const oldestRecent = oldestTimestamp(state.recent);

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
        typeof oldestRecent === "number"
          ? new Date(oldestRecent + RPM_WINDOW_MS).toISOString()
          : undefined,
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
