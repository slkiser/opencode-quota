/**
 * On OpenCode 2, quota slash commands from Web and Desktop post their report into the chat as
 * a user message that never starts a model turn. These helpers write the /quota report and
 * mark every such message, so the server plugin can keep it out of every model request.
 */
import type { QuotaSnapshot } from "../core/types.js";
import type { UsageReport } from "../core/usage.js";
import type { Notice } from "../rpc.js";
import { DEFAULT_WORDS } from "../view/format.js";
import { quickLookText } from "../view/quick-look.js";
import type { RowSettings, SurfaceRows } from "../view/select.js";
import { sanitizeDisplayText } from "./display-sanitize.js";

/** Metadata key on every quota report message. OpenCode stores message metadata with the message. */
export const QUOTA_REPORT_METADATA_KEY = "opencodeQuota";

export type QuotaReportMetadata = { command: string; at: number };

/**
 * First and last line of every quota report message; Web and Desktop show them too.
 * When OpenCode compacts a session, it copies recent message text into the checkpoint
 * before plugin hooks run, so the metadata is lost there. These lines let the plugin cut
 * the report back out of that text.
 */
const QUOTA_REPORT_START = "[OpenCode Quota report]";
const QUOTA_REPORT_END = "[End of OpenCode Quota report]";
const QUOTA_REPORT_BLOCKS = /\[OpenCode Quota report\][\s\S]*?\[End of OpenCode Quota report\]/g;

export function formatQuotaReportMessage(report: string): string {
  return `${QUOTA_REPORT_START}\n${report}\n${QUOTA_REPORT_END}`;
}

export function containsQuotaReport(text: string): boolean {
  return text.includes(QUOTA_REPORT_START);
}

/** Cuts every complete quota report, first to last line, out of the text. */
export function removeQuotaReports(text: string): string {
  return text.replace(QUOTA_REPORT_BLOCKS, "");
}

const EVERY_ROW: SurfaceRows = { hidden: [], providerOrder: [], rowOrder: {} };
/** Web and Desktop have no display settings: every provider and row, in the server's order. */
const NO_DISPLAY_CHOICES: RowSettings = {
  sidebar: EVERY_ROW,
  collapsed: EVERY_ROW,
  statusLine: EVERY_ROW,
  toast: EVERY_ROW,
};

/**
 * The limits of every provider as the /quota report of Web and Desktop writes them, without its
 * usage and notices: what the TUI's Limits tab copies. Like that tab, it ignores
 * `onlyCurrentModel`.
 */
export function quotaLimitsText(snapshot: QuotaSnapshot, nowMs: number): string {
  const words = { ...(snapshot.words ?? DEFAULT_WORDS), onlyCurrentModel: false };
  const text = quickLookText({
    snapshot: { ...snapshot, words },
    usage: undefined,
    settings: NO_DISPLAY_CHOICES,
    nowMs,
  });
  return sanitizeDisplayText(text);
}

/**
 * The /quota report of Web and Desktop: the short text of `view/quick-look.ts` for every
 * provider, then all active notices.
 */
export function quotaMessageText(params: {
  snapshot: QuotaSnapshot;
  usage: UsageReport | undefined;
  notices: Notice[];
  nowMs: number;
}): string {
  const { snapshot, usage, nowMs } = params;
  const quickLook = quickLookText({ snapshot, usage, settings: NO_DISPLAY_CHOICES, nowMs });
  const notices = params.notices.flatMap((notice) => [
    `- ${notice.message}`,
    ...(notice.url ? [`  ${notice.url}`] : []),
  ]);
  return [quickLook, ...(notices.length > 0 ? ["", "Notices", ...notices] : [])].join("\n");
}
