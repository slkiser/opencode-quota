/**
 * The active maintainer notices clients show, and the line at the bottom of Home that counts
 * them. The line shows on the first Home screen of each local day, for ten minutes, and the
 * state dir remembers that day's showing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Notice } from "../rpc.js";
import { writeJsonAtomic } from "./atomic-json.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  getMaintainerAnnouncementsSummary,
} from "./maintainer-announcements.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

// A daily Home notice stays this long after it first shows on a day, so the
// footer's one-minute refresh does not hide it while you are on Home.
const DAILY_HOME_NOTICE_VISIBLE_MS = 10 * 60_000;

const STATE_FILE_OPTIONS = { trailingNewline: true, directoryMode: 0o700, fileMode: 0o600 };

type DailyHomeNoticeClaim = { day: string; shownAtMs: number };

/** Today's claim when the state file could not be written; keeps this process to once a day. */
let unsavedDailyHomeNoticeClaim: DailyHomeNoticeClaim | undefined;

function statePath(name: string): string {
  return join(getOpencodeRuntimeDirs().stateDir, "opencode-quota", name);
}

/**
 * The active notices.
 * @param providerIds the providers quota shows (a notice can target some of them).
 */
export async function listNotices(params: {
  providerIds: string[];
  nowMs?: number;
}): Promise<Notice[]> {
  const summary = getMaintainerAnnouncementsSummary({
    enabledProviders: params.providerIds,
    announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
    nowMs: params.nowMs ?? Date.now(),
  });
  return summary.activeAnnouncements.map(({ announcement }) => ({
    id: announcement.id,
    message: announcement.message,
    ...(announcement.url ? { url: announcement.url } : {}),
  }));
}

/**
 * Whether the daily Home notice may show now. The first call on each local day
 * starts that day's window and records it in the state dir.
 */
async function claimDailyHomeNotice(nowMs: number): Promise<boolean> {
  const now = new Date(nowMs);
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  let shownAtMs: number | undefined;
  try {
    const state = JSON.parse(
      await readFile(statePath("maintainer-announcements-home.json"), "utf8"),
    ) as { day?: unknown; shownAtMs?: unknown };
    if (state.day === day && Number.isFinite(state.shownAtMs)) {
      shownAtMs = state.shownAtMs as number;
    }
  } catch {
    // No state yet, or unreadable: fall back to this process's claim.
  }
  if (shownAtMs === undefined && unsavedDailyHomeNoticeClaim?.day === day) {
    shownAtMs = unsavedDailyHomeNoticeClaim.shownAtMs;
  }
  if (shownAtMs !== undefined) {
    // A claim from the future (the clock went back) counts as used up.
    const elapsedMs = nowMs - shownAtMs;
    return elapsedMs >= 0 && elapsedMs < DAILY_HOME_NOTICE_VISIBLE_MS;
  }
  const claim: DailyHomeNoticeClaim = { day, shownAtMs: nowMs };
  try {
    await writeJsonAtomic(
      statePath("maintainer-announcements-home.json"),
      claim,
      STATE_FILE_OPTIONS,
    );
  } catch {
    unsavedDailyHomeNoticeClaim = claim;
  }
  return true;
}

/**
 * The Home line that counts the active notices, or "" when there is none to show now.
 * @param providerIds the providers quota shows (a notice can target some of them).
 */
export async function homeNoticeLine(params: {
  providerIds: string[];
  nowMs?: number;
}): Promise<string> {
  const nowMs = params.nowMs ?? Date.now();
  const notices = await listNotices({ providerIds: params.providerIds, nowMs });
  // Only a day with an active notice uses up that day's showing.
  if (notices.length === 0) return "";
  if (!(await claimDailyHomeNotice(nowMs))) return "";
  const count =
    notices.length === 1 ? "1 maintainer notice" : `${notices.length} maintainer notices`;
  return `Notice: ${count}, see /quota_status.`;
}

export function __resetMaintainerHomeNoticeForTests(): void {
  unsavedDailyHomeNoticeClaim = undefined;
}
