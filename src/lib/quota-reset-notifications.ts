import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-json.js";
import { isPercentEntry, type QuotaProviderResult, type QuotaToastEntry } from "./entries.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
import { classifyQuotaWindowText, type QuotaWindowKind } from "./quota-entry-display.js";
import type { QuotaResetWindow } from "./types.js";

const STATE_VERSION = 1;
const MAX_TRANSITION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const WINDOW_KINDS: Readonly<Record<QuotaResetWindow, QuotaWindowKind>> = {
  fiveHour: "five_hour",
  hourly: "hour",
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

type ResetObservation = {
  resetAtMs: number;
  percentRemaining: number;
  observedAtMs: number;
  notifiedResetAtMs?: number;
};

type ResetNotificationState = {
  version: typeof STATE_VERSION;
  observations: Record<string, ResetObservation>;
};

export type QuotaResetProviderResult = {
  providerId: string;
  result: QuotaProviderResult;
};

export type QuotaResetNotice = {
  providerId: string;
  label: string;
  window: QuotaResetWindow;
  percentRemaining: number;
};

function getStatePath(): string {
  return join(
    getOpencodeRuntimeDirs().stateDir,
    "opencode-quota",
    "quota-reset-notifications.json",
  );
}

function getWindow(entry: QuotaToastEntry): QuotaWindowKind | null {
  return classifyQuotaWindowText(entry.label ?? "") ?? classifyQuotaWindowText(entry.name);
}

function getConfiguredWindow(
  kind: QuotaWindowKind | null,
  configured: readonly QuotaResetWindow[],
): QuotaResetWindow | null {
  if (!kind) return null;
  return configured.find((window) => WINDOW_KINDS[window] === kind) ?? null;
}

function getIdentity(providerId: string, entry: QuotaToastEntry, window: QuotaResetWindow): string {
  const raw = [
    providerId,
    entry.accounting.sourceId ?? "",
    window,
    entry.group ?? "",
    entry.label ?? "",
    entry.name,
  ].join("\u001f");
  return createHash("sha256").update(raw).digest("hex");
}

function isObservation(value: unknown): value is ResetObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ResetObservation>;
  return (
    Number.isFinite(item.resetAtMs) &&
    Number.isFinite(item.percentRemaining) &&
    Number.isFinite(item.observedAtMs)
  );
}

async function readState(path: string): Promise<ResetNotificationState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ResetNotificationState>;
    if (parsed.version !== STATE_VERSION || !parsed.observations) throw new Error("invalid state");
    return {
      version: STATE_VERSION,
      observations: Object.fromEntries(
        Object.entries(parsed.observations).filter((entry) => isObservation(entry[1])),
      ),
    };
  } catch {
    return { version: STATE_VERSION, observations: {} };
  }
}

function didReset(previous: ResetObservation, current: ResetObservation, nowMs: number): boolean {
  const transitionAge = nowMs - previous.resetAtMs;
  return (
    previous.observedAtMs <= previous.resetAtMs &&
    transitionAge >= 0 &&
    transitionAge <= MAX_TRANSITION_AGE_MS &&
    current.resetAtMs > previous.resetAtMs &&
    current.resetAtMs > nowMs &&
    current.percentRemaining > previous.percentRemaining &&
    previous.percentRemaining < 100 &&
    previous.notifiedResetAtMs !== previous.resetAtMs
  );
}

export async function observeQuotaResetNotifications(params: {
  providers: QuotaResetProviderResult[];
  windows: readonly QuotaResetWindow[];
  nowMs?: number;
  statePath?: string;
}): Promise<QuotaResetNotice[]> {
  const nowMs = params.nowMs ?? Date.now();
  const statePath = params.statePath ?? getStatePath();
  const state = await readState(statePath);
  const observations = Object.fromEntries(
    Object.entries(state.observations).filter(
      ([, observation]) => nowMs - observation.observedAtMs <= MAX_OBSERVATION_AGE_MS,
    ),
  );
  const notices: QuotaResetNotice[] = [];

  for (const provider of params.providers) {
    for (const entry of provider.result.entries) {
      if (!isPercentEntry(entry)) continue;
      if (entry.accounting.resultType !== "quota" && entry.accounting.resultType !== "rate_limit") {
        continue;
      }
      if (!entry.resetTimeIso) continue;

      const window = getConfiguredWindow(getWindow(entry), params.windows);
      if (!window) continue;
      const resetAtMs = Date.parse(entry.resetTimeIso);
      if (!Number.isFinite(resetAtMs)) continue;

      const key = getIdentity(provider.providerId, entry, window);
      const previous = observations[key];
      const current: ResetObservation = {
        resetAtMs,
        percentRemaining: entry.percentRemaining,
        observedAtMs: nowMs,
      };

      if (previous && didReset(previous, current, nowMs)) {
        current.notifiedResetAtMs = previous.resetAtMs;
        notices.push({
          providerId: provider.providerId,
          label: entry.group?.trim() || getQuotaProviderDisplayLabel(provider.providerId),
          window,
          percentRemaining: entry.percentRemaining,
        });
      }

      observations[key] = current;
    }
  }

  await writeJsonAtomic(
    statePath,
    { version: STATE_VERSION, observations } satisfies ResetNotificationState,
    { trailingNewline: true, directoryMode: 0o700, fileMode: 0o600 },
  );
  return notices;
}

export function formatQuotaResetNotification(notices: readonly QuotaResetNotice[]): string | null {
  if (notices.length === 0) return null;
  const labels = [...new Set(notices.map((notice) => notice.label))];
  const shown = labels.slice(0, 3);
  const overflow = labels.length - shown.length;
  const providers = `${shown.join(", ")}${overflow > 0 ? ` and ${overflow} more` : ""}`;

  const [notice] = notices;
  if (notice && notices.length === 1) {
    const window = notice.window === "weekly" ? "Weekly" : "Quota";
    return `${window} quota reset: ${providers} is available again (${Math.round(notice.percentRemaining)}% remaining).`;
  }
  return `Quota reset: ${providers} are available again.`;
}
