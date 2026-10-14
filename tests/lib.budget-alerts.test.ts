import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";

import {
  getBudgetAlertRules,
  createBudgetAlertRule,
  updateBudgetAlertRule,
  deleteBudgetAlertRule,
  evaluateBudgetAlert,
  evaluateAllBudgetAlerts,
  getWindowSinceMs,
  getWindowLabel,
  describeScope,
  clearBudgetAlertsCache,
  type BudgetAlertRule,
  type BudgetAlertUsage,
} from "../src/lib/budget-alerts.js";

const testDir = join(tmpdir(), `opencode-quota-test-budget-alerts-${Date.now()}`);

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = testDir;
  process.env.XDG_DATA_HOME = testDir;
  process.env.XDG_CACHE_HOME = testDir;
  process.env.XDG_STATE_HOME = testDir;
  process.env.HOME = testDir;
  mkdirSync(join(testDir, "opencode-quota"), { recursive: true });
  clearBudgetAlertsCache();
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function makeUsage(overrides: Partial<BudgetAlertUsage> = {}): BudgetAlertUsage {
  return {
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    costUsd: 0,
    messageCount: 0,
    ...overrides,
  };
}

describe("budget-alerts", () => {
  describe("CRUD operations", () => {
    it("returns empty array when no rules exist", async () => {
      const rules = await getBudgetAlertRules();
      expect(rules).toEqual([]);
    });

    it("creates a rule", async () => {
      const rule = await createBudgetAlertRule({
        name: "Daily spend cap",
        scope: { type: "global" },
        window: "day",
        metric: "cost_usd",
        threshold: 5,
        direction: "above",
      });

      expect(rule.name).toBe("Daily spend cap");
      expect(rule.enabled).toBe(true);
      expect(rule.scope.type).toBe("global");
      expect(rule.window).toBe("day");
      expect(rule.id).toMatch(/^balert_/);
    });

    it("updates a rule", async () => {
      const rule = await createBudgetAlertRule({
        name: "Old name",
        scope: { type: "global" },
        window: "day",
        metric: "cost_usd",
        threshold: 5,
        direction: "above",
      });

      const updated = await updateBudgetAlertRule(rule.id, {
        name: "New name",
        threshold: 10,
        enabled: false,
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New name");
      expect(updated!.threshold).toBe(10);
      expect(updated!.enabled).toBe(false);
      expect(updated!.createdAt).toBe(rule.createdAt);
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(rule.updatedAt);
    });

    it("returns null when updating nonexistent rule", async () => {
      const result = await updateBudgetAlertRule("nonexistent", { name: "test" });
      expect(result).toBeNull();
    });

    it("deletes a rule", async () => {
      const rule = await createBudgetAlertRule({
        name: "To delete",
        scope: { type: "global" },
        window: "day",
        metric: "cost_usd",
        threshold: 5,
        direction: "above",
      });

      const deleted = await deleteBudgetAlertRule(rule.id);
      expect(deleted).toBe(true);

      const remaining = await getBudgetAlertRules();
      expect(remaining).toHaveLength(0);
    });

    it("returns false when deleting nonexistent rule", async () => {
      const result = await deleteBudgetAlertRule("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("evaluateBudgetAlert", () => {
    const baseRule: BudgetAlertRule = {
      id: "test-1",
      enabled: true,
      name: "Test Alert",
      scope: { type: "global" },
      window: "day",
      metric: "cost_usd",
      threshold: 10,
      direction: "above",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    it("does not trigger when usage is below threshold (direction: above)", () => {
      const result = evaluateBudgetAlert(baseRule, makeUsage({ costUsd: 5 }));
      expect(result.triggered).toBe(false);
      expect(result.percentUsed).toBe(50);
    });

    it("triggers when usage exceeds threshold (direction: above)", () => {
      const result = evaluateBudgetAlert(baseRule, makeUsage({ costUsd: 12 }));
      expect(result.triggered).toBe(true);
      expect(result.percentUsed).toBe(120);
    });

    it("does not trigger when disabled", () => {
      const disabledRule = { ...baseRule, enabled: false };
      const result = evaluateBudgetAlert(disabledRule, makeUsage({ costUsd: 100 }));
      expect(result.triggered).toBe(false);
      expect(result.message).toBe("Rule is disabled");
    });

    it("triggers when below threshold (direction: below)", () => {
      const lowRule = { ...baseRule, direction: "below" as const, threshold: 100 };
      const result = evaluateBudgetAlert(lowRule, makeUsage({ costUsd: 50 }));
      expect(result.triggered).toBe(true);
    });

    it("handles token metrics", () => {
      const tokenRule = {
        ...baseRule,
        metric: "tokens_total" as const,
        threshold: 1000,
      };
      const result = evaluateBudgetAlert(
        tokenRule,
        makeUsage({
          tokens: { input: 500, output: 600, reasoning: 0, cache_read: 0, cache_write: 0 },
        }),
      );
      expect(result.triggered).toBe(true);
      expect(result.currentValue).toBe(1100);
    });

    it("handles zero threshold gracefully", () => {
      const zeroRule = { ...baseRule, threshold: 0 };
      const result = evaluateBudgetAlert(zeroRule, makeUsage({ costUsd: 5 }));
      expect(result.triggered).toBe(true);
      expect(result.percentUsed).toBe(0); // division by zero prevention
    });
  });

  describe("evaluateAllBudgetAlerts", () => {
    it("evaluates multiple rules against usage map", () => {
      const rules: BudgetAlertRule[] = [
        {
          id: "r1",
          enabled: true,
          name: "Global cap",
          scope: { type: "global" },
          window: "day",
          metric: "cost_usd",
          threshold: 10,
          direction: "above",
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: "r2",
          enabled: true,
          name: "OpenAI cap",
          scope: { type: "provider", providerId: "openai" },
          window: "day",
          metric: "cost_usd",
          threshold: 5,
          direction: "above",
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const usageMap = new Map<string, BudgetAlertUsage>([
        ["__global__", makeUsage({ costUsd: 15 })],
        ["openai/gpt-5", makeUsage({ costUsd: 3 })],
        ["openai/gpt-4o", makeUsage({ costUsd: 1 })],
      ]);

      const results = evaluateAllBudgetAlerts(rules, usageMap);
      expect(results).toHaveLength(2);
      expect(results[0]!.triggered).toBe(true); // global: 15 > 10
      expect(results[1]!.triggered).toBe(false); // openai: 3+1 = 4 < 5
    });

    it("handles missing usage data gracefully", () => {
      const rules: BudgetAlertRule[] = [
        {
          id: "r1",
          enabled: true,
          name: "Test",
          scope: { type: "model", providerId: "unknown", modelId: "unknown" },
          window: "day",
          metric: "cost_usd",
          threshold: 5,
          direction: "above",
          createdAt: 0,
          updatedAt: 0,
        },
      ];

      const results = evaluateAllBudgetAlerts(rules, new Map());
      expect(results).toHaveLength(1);
      expect(results[0]!.triggered).toBe(false);
      expect(results[0]!.message).toContain("No usage data");
    });
  });

  describe("utility functions", () => {
    it("getWindowSinceMs returns correct offsets", () => {
      const now = Date.now();
      const daySince = getWindowSinceMs("day")!;
      const weekSince = getWindowSinceMs("week")!;
      const monthSince = getWindowSinceMs("month")!;
      const allSince = getWindowSinceMs("all");

      expect(now - daySince).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(now - daySince).toBeLessThan(25 * 60 * 60 * 1000);
      expect(now - weekSince).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
      expect(now - monthSince).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
      expect(allSince).toBeUndefined();
    });

    it("getWindowLabel returns human-readable labels", () => {
      expect(getWindowLabel("day")).toBe("24 hours");
      expect(getWindowLabel("week")).toBe("7 days");
      expect(getWindowLabel("month")).toBe("30 days");
      expect(getWindowLabel("all")).toBe("All time");
    });

    it("describeScope returns human-readable descriptions", () => {
      expect(describeScope({ type: "global" })).toBe("All providers");
      expect(describeScope({ type: "provider", providerId: "openai" })).toBe("openai");
      expect(describeScope({ type: "model", providerId: "openai", modelId: "gpt-5" })).toBe(
        "openai/gpt-5",
      );
    });
  });
  it("reports malformed rules to strict readers even after a cached successful read", async () => {
    await getBudgetAlertRules();
    const dir = join(testDir, "opencode", "opencode-quota");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "budget-alerts.json"), "{broken");
    await expect(getBudgetAlertRules({ strictReads: true, forceReload: true })).rejects.toThrow(
      "Budget rules unavailable",
    );
  });
});
