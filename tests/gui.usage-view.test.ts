import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { UsageReport } from "../src/core/usage.js";
import { en } from "../src/gui/i18n.js";
import { UsageView } from "../src/gui/usage-view.js";
import { stubJsx } from "./helpers/fake-tui-host.js";

function report(requests: number): UsageReport {
  const byType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return {
    range: "7d",
    generatedAtMs: Date.now(),
    totals: {
      costUsd: 0,
      sessions: 0,
      requests,
      tokens: { processed: 0, cachedInput: 0, uncachedInput: 0, output: 0 },
      tokensByType: byType,
      costByType: byType,
      cacheSavingsUsd: 0,
      unpricedTokens: 0,
      unpricedShare: 0,
    },
    providers: [],
    models: [],
    days: [],
  };
}

function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

function render(requests: number, providerId?: string): string {
  const messages: Record<string, string> = en;
  const ctx = {
    t: (key: string) => messages[key] ?? key,
    plural: (_key: string, count: number) => `${count} sessions`,
    locale: { locale: () => "en-US" },
    dialogs: { open: vi.fn() },
  };
  stubJsx();
  try {
    return createRoot((dispose) => {
      const tree = UsageView({
        ctx: ctx as never,
        report: report(requests),
        mode: "tokens",
        providerId,
        rangeLabel: "7 days",
      });
      const text = textOf(tree);
      dispose();
      return text;
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("GUI usage totals", () => {
  it("shows the exact requests total when requests have no token usage", () => {
    const text = render(1_234);
    expect(text).toContain("Requests1,234");
    expect(text).not.toContain("No tokens used in this range.");
  });

  it("keeps the empty state when the report has neither tokens nor requests", () => {
    expect(render(0)).toContain("No tokens used in this range.");
  });

  it("marks the request count report-wide when a provider filter is selected", () => {
    expect(render(1_234, "openai")).toContain("Requests (all providers)1,234");
  });
});
