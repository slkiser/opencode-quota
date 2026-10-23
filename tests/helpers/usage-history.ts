/** OpenCode's usage history as the Usage tab tests use it, and the dates typed for it. */
import { writeSessionDatabase } from "./session-database.js";

/**
 * OpenCode's history for the Usage tab: this session a minute ago with `modelID`, and an older
 * session 10 days ago with an unpriced model.
 */
export function writeUsageHistory(databasePath: string, modelID = "claude-sonnet-4-5"): void {
  const now = Date.now();
  const old = now - 10 * 24 * 60 * 60_000;
  writeSessionDatabase(databasePath, {
    sessions: [
      { id: "ses_1", created: now - 3_600_000 },
      { id: "ses_old", created: old },
    ],
    messages: [
      {
        id: "msg_1",
        sessionID: "ses_1",
        created: now - 60_000,
        completed: now - 59_000,
        providerID: "anthropic",
        modelID,
        tokens: { input: 1_000_000, output: 100_000 },
      },
      {
        id: "msg_old",
        sessionID: "ses_old",
        created: old,
        completed: old + 1_000,
        providerID: "acme",
        modelID: "mystery-old",
        tokens: { output: 500_000 },
      },
    ],
  });
}

/** The local date `days` calendar days from today, like "2026-10-01". */
export function localDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}
