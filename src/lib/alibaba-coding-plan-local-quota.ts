import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import { clampPercent } from "./format-utils.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type { OpenCodeMessage } from "./opencode-storage.js";
import { iterCompletedAssistantMessages } from "./opencode-storage.js";
import type { AlibabaCodingPlanTier } from "./types.js";

export const ALIBABA_CODING_PLAN_STATE_VERSION = 1 as const;
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const ALIBABA_CODING_PLAN_LIMITS: Readonly<
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

interface AlibabaCodingPlanStateFileV1 {
  version: 1;
  recent: number[];
  updatedAt: number;
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

function defaultAlibabaState(nowMs: number): AlibabaCodingPlanStateFileV1 {
  return {
    version: ALIBABA_CODING_PLAN_STATE_VERSION,
    recent: [],
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
  writeState?: (path: string, state: AlibabaCodingPlanStateFileV1) => Promise<void>;
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
  state: AlibabaCodingPlanStateFileV1,
  dependencies: MaintainedLocalQuotaDependencies,
): Promise<void> {
  const writeState =
    dependencies.writeState ??
    ((target, value) => writeJsonAtomic(target, value, { trailingNewline: true }));
  await writeState(path, state);
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
