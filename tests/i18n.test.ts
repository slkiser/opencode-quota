import { describe, expect, it } from "vite-plus/test";
import { resolveUiLocale, translate, translatePlural } from "../src/i18n.js";

describe("quota interface localization", () => {
  it("uses the host locale for auto and lets an explicit persisted choice win", () => {
    expect(resolveUiLocale("auto", "zh-CN")).toBe("zh-Hans");
    expect(resolveUiLocale("zh-Hans", "en-US")).toBe("zh-Hans");
    expect(resolveUiLocale("en", "zh-CN")).toBe("en");
    expect(resolveUiLocale("auto", "zh-TW")).toBe("en");
  });

  it("falls back to English for missing keys and interpolates translated parameters", () => {
    expect(translate("zh-Hans", "command.quota")).toBe("配额");
    expect(translate("zh-Hans", "setting.sidebar.show")).toBe("配额侧边栏面板");
    expect(translate("zh-Hans", "language.en")).toBe("English");
    expect(
      translate("zh-Hans", "providers.custom.remote", {
        key: "OPENAI_API_KEY",
        url: "https://example.test",
      }),
    ).toBe("将密钥 OPENAI_API_KEY 发送到 https://example.test。");
  });

  it("translates the Desktop composer-pill setting", () => {
    for (const key of [
      "setting.statusLine.composerPill",
      "setting.statusLine.composerPill.description",
    ]) {
      const english = translate("en", key);
      expect(english).not.toBe(key);
      expect(translate("zh-Hans", key)).not.toBe(english);
    }
  });

  it("selects locale plural categories and falls back when a category is missing", () => {
    expect(translatePlural("zh-Hans", "usage.sessions", 2)).toBe("2 个会话");
    expect(translatePlural("en", "usage.sessions", 2)).toBe("2 sessions");
  });

  it("includes request labels in both central catalogs", () => {
    expect(translate("en", "usage.requests")).toBe("Requests");
    expect(translate("en", "usage.requestsAllProviders")).toBe("Requests across all providers");
    expect(translate("zh-Hans", "usage.requests")).toBe("请求数");
    expect(translate("zh-Hans", "usage.requestsAllProviders")).toBe("所有提供方的请求数");
  });

  it("translates fixed usage command errors without altering their argument values", () => {
    expect(translate("zh-Hans", "tui.usage.error.unknownRange", { range: "session_tree" })).toBe(
      '未知范围 "session_tree"。',
    );
    expect(translate("zh-Hans", "tui.usage.error.invalidDate", { date: "2026-09-31" })).toBe(
      '"2026-09-31" 不是有效日期。',
    );
  });
});
