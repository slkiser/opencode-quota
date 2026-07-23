/**
 * Shared session-token fetching helper.
 *
 * Consolidates the duplicated try/catch + error-capture logic that was
 * previously inlined in both `fetchQuotaMessage()` and
 * `fetchQuotaCommandMessage()` in plugin.ts.
 */

import type { SessionTokensData } from "./entries.js";
import {
  getSessionTokenSummary,
  getSessionTreeTokenSummary,
  SessionNotFoundError,
} from "./quota-stats.js";
import type { SessionTokenError } from "./quota-status.js";
import type { SessionTokenScope } from "./types.js";

export interface SessionTokenFetchResult {
  sessionTokens?: SessionTokensData;
  error?: SessionTokenError;
}

/**
 * Fetch session token summary for display.
 *
 * @returns `sessionTokens` on success (undefined if no data),
 *          `error` on failure (for diagnostics).
 *          When both are undefined the feature was disabled or sessionID missing.
 */
export async function fetchSessionTokensForDisplay(params: {
  enabled: boolean;
  sessionID?: string;
  scope: SessionTokenScope;
}): Promise<SessionTokenFetchResult> {
  if (!params.enabled || !params.sessionID) return {};

  try {
    const summary =
      params.scope === "tree"
        ? await getSessionTreeTokenSummary(params.sessionID)
        : await getSessionTokenSummary(params.sessionID);
    if (summary && summary.models.length > 0) {
      return {
        sessionTokens: {
          models: summary.models,
          totalInput: summary.totalInput,
          totalCachedInput: summary.totalCachedInput,
          totalCombinedInput: summary.totalCombinedInput,
          totalOutput: summary.totalOutput,
        },
      };
    }
    // Success but no data — clear any previous error
    return {};
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return {
        error: {
          sessionID: err.sessionID,
          error: err.message,
          checkedPath: err.checkedPath,
        },
      };
    }
    return {
      error: {
        sessionID: params.sessionID,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
