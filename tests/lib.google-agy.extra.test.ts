import { describe, expect, it } from "vite-plus/test";
import { formatDisplayName, queryGoogleAgyQuota } from "../src/lib/google-agy";

describe("google-agy extra logic", () => {
  describe("formatDisplayName", () => {
    it("should format Claude models correctly", () => {
      expect(formatDisplayName("claude-3-5-sonnet")).toBe("Claude 3.5 Sonnet");
      expect(formatDisplayName("claude-3-opus")).toBe("Claude 3 Opus");
      expect(formatDisplayName("claude-3-sonnet")).toBe("Claude 3 Sonnet");
      expect(formatDisplayName("claude-3-5-haiku")).toBe("Claude 3.5 Haiku");
    });

    it("should format GPT-OSS models correctly", () => {
      expect(formatDisplayName("gpt_oss_120b_medium")).toBe("GPT-OSS 120B (Medium)");
      expect(formatDisplayName("gpt_oss_7b")).toBe("GPT-OSS 7B");
    });

    it("should format Gemini models correctly", () => {
      expect(formatDisplayName("gemini-1-5-pro")).toBe("Gemini 1.5 Pro");
      expect(formatDisplayName("gemini-1-0-pro")).toBe("Gemini 1.0 Pro");
    });
  });
});
