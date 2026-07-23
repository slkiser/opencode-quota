import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionTokenSummary: vi.fn(),
  getSessionTreeTokenSummary: vi.fn(),
}));

vi.mock("../src/lib/quota-stats.js", () => {
  class SessionNotFoundError extends Error {
    sessionID: string;
    checkedPath: string;

    constructor(sessionID: string, checkedPath: string) {
      super(`Session not found: ${sessionID}`);
      this.name = "SessionNotFoundError";
      this.sessionID = sessionID;
      this.checkedPath = checkedPath;
    }
  }

  return {
    ...mocks,
    SessionNotFoundError,
  };
});

import { fetchSessionTokensForDisplay } from "../src/lib/session-tokens.js";

const summary = {
  sessionID: "ses_root",
  models: [
    {
      modelID: "gpt-5",
      input: 1200,
      cachedInput: 300,
      totalInput: 1500,
      output: 45,
    },
  ],
  totalInput: 1200,
  totalCachedInput: 300,
  totalCombinedInput: 1500,
  totalOutput: 45,
};

describe("fetchSessionTokensForDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps current-session fetching as the default scope behavior", async () => {
    mocks.getSessionTokenSummary.mockResolvedValue(summary);

    await expect(
      fetchSessionTokensForDisplay({
        enabled: true,
        sessionID: "ses_root",
        scope: "current",
      }),
    ).resolves.toEqual({
      sessionTokens: {
        models: summary.models,
        totalInput: 1200,
        totalCachedInput: 300,
        totalCombinedInput: 1500,
        totalOutput: 45,
      },
    });
    expect(mocks.getSessionTokenSummary).toHaveBeenCalledWith("ses_root");
    expect(mocks.getSessionTreeTokenSummary).not.toHaveBeenCalled();
  });

  it("uses the descendant aggregation only for tree scope", async () => {
    mocks.getSessionTreeTokenSummary.mockResolvedValue(summary);

    await expect(
      fetchSessionTokensForDisplay({
        enabled: true,
        sessionID: "ses_root",
        scope: "tree",
      }),
    ).resolves.toEqual({
      sessionTokens: {
        models: summary.models,
        totalInput: 1200,
        totalCachedInput: 300,
        totalCombinedInput: 1500,
        totalOutput: 45,
      },
    });
    expect(mocks.getSessionTreeTokenSummary).toHaveBeenCalledWith("ses_root");
    expect(mocks.getSessionTokenSummary).not.toHaveBeenCalled();
  });

  it("does not read session storage when token display is disabled or the session is missing", async () => {
    await expect(
      fetchSessionTokensForDisplay({ enabled: false, sessionID: "ses_root", scope: "tree" }),
    ).resolves.toEqual({});
    await expect(fetchSessionTokensForDisplay({ enabled: true, scope: "tree" })).resolves.toEqual(
      {},
    );
    expect(mocks.getSessionTokenSummary).not.toHaveBeenCalled();
    expect(mocks.getSessionTreeTokenSummary).not.toHaveBeenCalled();
  });
});
