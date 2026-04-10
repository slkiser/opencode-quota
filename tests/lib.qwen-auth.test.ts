import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
  hasQwenOAuthAuth,
  hasQwenOAuthAuthCached,
  resolveQwenLocalPlan,
  resolveQwenLocalPlanCached,
} from "../src/lib/qwen-auth.js";

describe("qwen auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the canonical qwen-code auth entry", () => {
    expect(
      resolveQwenLocalPlan({
        "qwen-code": { type: "oauth", access: "canonical-token" },
      }),
    ).toEqual({
      state: "qwen_free",
      accessToken: "canonical-token",
      sourceKey: "qwen-code",
    });
  });

  it("supports the legacy opencode-qwencode-auth key", () => {
    expect(
      resolveQwenLocalPlan({
        "opencode-qwencode-auth": { type: "oauth", access: "legacy-token" },
      }),
    ).toEqual({
      state: "qwen_free",
      accessToken: "legacy-token",
      sourceKey: "opencode-qwencode-auth",
    });
  });

  it("prefers the canonical key when both auth entries are valid", () => {
    expect(
      resolveQwenLocalPlan({
        "qwen-code": { type: "oauth", access: "canonical-token" },
        "opencode-qwencode-auth": { type: "oauth", access: "legacy-token" },
      }),
    ).toEqual({
      state: "qwen_free",
      accessToken: "canonical-token",
      sourceKey: "qwen-code",
    });
  });

  it("falls back to the legacy key when the canonical entry is unusable", () => {
    expect(
      resolveQwenLocalPlan({
        "qwen-code": { type: "oauth", access: "   " },
        "opencode-qwencode-auth": { type: "oauth", access: "legacy-token" },
      }),
    ).toEqual({
      state: "qwen_free",
      accessToken: "legacy-token",
      sourceKey: "opencode-qwencode-auth",
    });
  });

  it("rejects invalid qwen auth entries", () => {
    expect(
      hasQwenOAuthAuth({
        "qwen-code": { type: "api", access: "token" },
        "opencode-qwencode-auth": { type: "oauth", access: "   " },
      }),
    ).toBe(false);
    expect(resolveQwenLocalPlan({ "qwen-code": { type: "oauth", access: "   " } })).toEqual({
      state: "none",
    });
  });

  it("uses cached auth reads for hasQwenOAuthAuthCached", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "qwen-code": { type: "oauth", access: "cached-token" },
    });

    await expect(hasQwenOAuthAuthCached()).resolves.toBe(true);
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
    });
  });

  it("uses cached auth reads for resolveQwenLocalPlanCached", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "opencode-qwencode-auth": { type: "oauth", access: "legacy-token" },
    });

    await expect(resolveQwenLocalPlanCached({ maxAgeMs: -1 })).resolves.toEqual({
      state: "qwen_free",
      accessToken: "legacy-token",
      sourceKey: "opencode-qwencode-auth",
    });
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({ maxAgeMs: 0 });
  });
});
