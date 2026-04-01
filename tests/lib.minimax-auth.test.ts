import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  resolveMiniMaxAuth,
  resolveMiniMaxAuthCached,
} from "../src/lib/minimax-auth.js";

const withMiniMaxAuth = (entry: unknown) => ({
  "minimax-coding-plan": entry,
});

describe("minimax auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveMiniMaxAuth", () => {
    it.each([
      ["auth is null", null, { state: "none" }],
      ["auth is undefined", undefined, { state: "none" }],
      ["minimax-coding-plan entry is missing", {}, { state: "none" }],
    ])("returns %j when %s", (_label, auth, expected) => {
      expect(resolveMiniMaxAuth(auth as any)).toEqual(expected);
    });

    it.each([
      [
        "type is not 'api'",
        withMiniMaxAuth({ type: "oauth", key: "some-key" }),
        { state: "invalid", error: 'Unsupported MiniMax auth type: "oauth"' },
      ],
      [
        "invalid auth type text is sanitized",
        withMiniMaxAuth({ type: "\u001b[31moauth\nretry\u001b[0m", key: "some-key" }),
        { state: "invalid", error: 'Unsupported MiniMax auth type: "oauth retry"' },
      ],
      [
        "auth entry is not an object",
        withMiniMaxAuth("bad-shape"),
        { state: "invalid", error: "MiniMax auth entry has invalid shape" },
      ],
      [
        "auth type is missing or invalid",
        withMiniMaxAuth({ type: { bad: true }, key: 123 }),
        { state: "invalid", error: "MiniMax auth entry present but type is missing or invalid" },
      ],
      [
        "type is api but credentials are empty",
        withMiniMaxAuth({ type: "api", key: "", access: "" }),
        { state: "invalid", error: "MiniMax auth entry present but credentials are empty" },
      ],
      [
        "type is api but credentials are whitespace-only",
        withMiniMaxAuth({ type: "api", key: "   ", access: "  " }),
        { state: "invalid", error: "MiniMax auth entry present but credentials are empty" },
      ],
    ])("returns %j when %s", (_label, auth, expected) => {
      expect(resolveMiniMaxAuth(auth as any)).toEqual(expected);
    });

    it.each([
      [
        "key when both key and access are present",
        withMiniMaxAuth({ type: "api", key: "primary-key", access: "access-key" }),
        { state: "configured", apiKey: "primary-key" },
      ],
      [
        "key over access",
        withMiniMaxAuth({ type: "api", key: "the-key", access: "the-access" }),
        { state: "configured", apiKey: "the-key" },
      ],
      [
        "access when key is missing",
        withMiniMaxAuth({ type: "api", access: "access-token" }),
        { state: "configured", apiKey: "access-token" },
      ],
      [
        "access when key is whitespace",
        withMiniMaxAuth({ type: "api", key: "  ", access: "access-token" }),
        { state: "configured", apiKey: "access-token" },
      ],
      [
        "trimmed key",
        withMiniMaxAuth({ type: "api", key: "  my-key  " }),
        { state: "configured", apiKey: "my-key" },
      ],
      [
        "trimmed access",
        withMiniMaxAuth({ type: "api", access: "  my-access  " }),
        { state: "configured", apiKey: "my-access" },
      ],
    ])("returns %j when using %s", (_label, auth, expected) => {
      expect(resolveMiniMaxAuth(auth as any)).toEqual(expected);
    });
  });

  describe("resolveMiniMaxAuthCached", () => {
    it("uses cached auth reads for resolveMiniMaxAuthCached", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce(
        withMiniMaxAuth({ type: "api", key: "cached-key" }),
      );

      await expect(resolveMiniMaxAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "cached-key",
      });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
        maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
      });
    });

    it("respects custom maxAgeMs in resolveMiniMaxAuthCached", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce(withMiniMaxAuth({ type: "api", key: "key" }));

      await resolveMiniMaxAuthCached({ maxAgeMs: 10_000 });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({ maxAgeMs: 10_000 });
    });

    it("clamps negative maxAgeMs to 0", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce({});

      await resolveMiniMaxAuthCached({ maxAgeMs: -500 });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({ maxAgeMs: 0 });
    });
  });
});
