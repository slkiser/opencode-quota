import type { Context } from "@opencode/plugin/gui";
import { createComponent, createSignal } from "solid-js";
import { renderToString, ssrElement } from "solid-js/web";
import { describe, expect, it, vi } from "vite-plus/test";
import type { UsageByType, UsageReport } from "../src/core/usage.js";
import { UsageView, usageFormatters } from "../src/gui/usage-view.js";
import { translate, translatePlural, type UiLocale } from "../src/i18n.js";

const byType: UsageByType = { input: 8_000, cacheRead: 2_000, cacheWrite: 0, output: 2_345 };

function makeReport(requests?: number): UsageReport {
  return {
    range: "7d",
    generatedAtMs: new Date(2026, 9, 27, 12).getTime(),
    totals: {
      costUsd: 1_234.56,
      sessions: 1,
      tokens: { processed: 12_345, cachedInput: 2_000, uncachedInput: 8_000, output: 2_345 },
      tokensByType: byType,
      costByType: { input: 1_000, cacheRead: 200, cacheWrite: 0, output: 34.56 },
      cacheSavingsUsd: 0,
      unpricedTokens: 0,
      unpricedShare: 0,
      ...(requests === undefined ? {} : { requests }),
    },
    providers: [
      {
        providerID: "openai",
        sessions: 1,
        costUsd: 1_234.56,
        costShare: 1,
        tokens: 12_345,
        tokenShare: 1,
        unpricedTokens: 0,
      },
    ],
    models: [
      {
        providerID: "openai",
        modelID: "gpt-5",
        costUsd: 1_234.56,
        costShare: 1,
        tokens: 12_345,
        tokenShare: 1,
        unpricedTokens: 0,
        priced: true,
        costByType: { input: 1_000, cacheRead: 200, cacheWrite: 0, output: 34.56 },
        tokensByType: byType,
        days: [{ date: "2026-10-27", costUsd: 1_234.56, tokens: 12_345, priced: true }],
      },
    ],
    days: [
      {
        date: "2026-10-27",
        costUsd: 1_234.56,
        costShare: 1,
        tokens: 12_345,
        tokenShare: 1,
        unpricedTokens: 0,
      },
    ],
  };
}

function requestOnlyReport(requests?: number): UsageReport {
  const report = makeReport(requests);
  return {
    ...report,
    totals: {
      ...report.totals,
      costUsd: 0,
      tokens: { processed: 0, cachedInput: 0, uncachedInput: 0, output: 0 },
      tokensByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      cacheSavingsUsd: 0,
      unpricedTokens: 0,
      unpricedShare: 0,
    },
    providers: [],
    models: [],
    days: [],
  };
}

function context(locale: () => UiLocale): Context {
  return {
    locale: { locale },
    t: (key, params) => translate(locale(), key, params),
    plural: (key, count, params) => translatePlural(locale(), key, count, params),
  } as unknown as Context;
}

function renderUsage(report: UsageReport, ctx: Context, providerId?: string): string {
  // Vite+ compiles test TSX through classic JSX; bridge that factory to Solid's server renderer.
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => {
      const elementProps = {
        ...props,
        ...(children.length === 0
          ? {}
          : { children: children.length === 1 ? children[0] : children }),
      };
      if (type === undefined) return children;
      return typeof type === "string"
        ? ssrElement(type, elementProps, elementProps.children, false)
        : createComponent(type as (props: Record<string, unknown>) => JSX.Element, elementProps);
    },
  });
  return renderToString(() =>
    UsageView({ ctx, report, mode: "tokens", providerId, rangeLabel: "Last 7 days" }),
  );
}

function textOfMarkup(markup: string): string {
  return markup.replace(/<[^>]*>/gu, "");
}

describe("GUI usage view", () => {
  it("formats the view again when its selected locale changes", () => {
    const [locale, setLocale] = createSignal<UiLocale>("en");
    const ctx = context(locale);
    const format = usageFormatters(ctx, "tokens");

    expect(format.value(12_345)).toBe("12.3K");
    expect(format.dateLabel("2026-10-27", false)).toBe("Oct 27");
    setLocale("zh-Hans");
    expect(format.value(12_345)).toBe("1.23万");
    expect(format.dateLabel("2026-10-27", false)).toBe("10月27日");
    setLocale("en");

    const english = renderUsage(makeReport(), ctx);
    setLocale("zh-Hans");
    const chinese = renderUsage(makeReport(), ctx);

    expect(english).toContain("12.3K");
    expect(chinese).toContain("1.23万");
    expect(english).toContain("$1,234.56");
    expect(chinese).toContain("US$1,234.56");
  });

  it("shows request-only usage with the localized request label", () => {
    const [locale, setLocale] = createSignal<UiLocale>("en");
    const ctx = context(locale);
    const english = renderUsage(requestOnlyReport(1_234_567), ctx);
    const providerEnglish = renderUsage(requestOnlyReport(1_234_567), ctx, "openai");

    setLocale("zh-Hans");
    const chinese = renderUsage(requestOnlyReport(1_234_567), ctx);
    const chineseProvider = renderUsage(requestOnlyReport(1_234_567), ctx, "openai");

    const englishText = textOfMarkup(english);
    const providerEnglishText = textOfMarkup(providerEnglish);
    const chineseText = textOfMarkup(chinese);
    const chineseProviderText = textOfMarkup(chineseProvider);
    expect(englishText).toContain("Requests");
    expect(englishText).not.toContain("Requests across all providers");
    expect(providerEnglishText).toContain("Requests across all providers");
    expect(englishText).toContain("1,234,567");
    expect(providerEnglishText).toContain("1,234,567");
    expect(chineseText).toContain("请求数");
    expect(chineseText).not.toContain("所有提供方的请求数");
    expect(chineseProviderText).toContain("所有提供方的请求数");
    expect(chineseText).toContain("1,234,567");
    expect(chinese).not.toContain("此时间范围内没有令牌用量。");
  });

  it.each([undefined, 0])(
    "shows the empty state for request-only data with requests=%s",
    (requests) => {
      const ctx = context(() => "en");
      expect(renderUsage(requestOnlyReport(requests), ctx)).toContain("No usage in this range.");
    },
  );

  it("shows request-only usage when requests are positive even though tokens are zero", () => {
    const ctx = context(() => "en");
    const rendered = textOfMarkup(renderUsage(requestOnlyReport(1), ctx));

    expect(rendered).toContain("Requests");
    expect(rendered).toContain("1");
    expect(rendered).not.toContain("No usage in this range.");
  });
});
