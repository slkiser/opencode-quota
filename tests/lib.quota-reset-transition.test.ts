import { describe, expect, it } from "vitest";
import { detectQuotaReset, type ResetEvidence } from "../src/lib/quota-reset-transition.js";
import { openAIAccounting } from "../src/providers/accounting-adapters.js";
const now = Date.parse("2026-10-15T12:00:00Z");
function evidence(id: string, reset: number, remaining: number, observedAt: number): ResetEvidence {
  const row = openAIAccounting({
    success: true,
    label: "OpenAI Weekly",
    windows: {
      weekly: { percentRemaining: remaining, resetTimeIso: new Date(reset).toISOString() },
    },
  }).rows[0];
  row.account = { kind: "opaque", digest: "a".repeat(64) };
  return { observationId: id, observedAt, row };
}
const before = () => evidence("before", now - 1000, 25, now - 2000);
const after = () => evidence("after", now + 604800000, 100, now);
describe("account/window-qualified quota reset transitions", () => {
  it("does not reuse the legacy ten-point history heuristic as notification policy", () => {
    const current = after();
    current.row.value = { kind: "percent", remaining: 25.01 };
    expect(detectQuotaReset("openai", before(), current, now)).not.toBeNull();
  });
  it("detects confirmed boundary passage, a newer boundary and replenishment, with stable event identity", () => {
    const event = detectQuotaReset("openai", before(), after(), now);
    expect(event).toMatchObject({
      providerId: "openai",
      accountIdentity: "a".repeat(64),
      windowId: "weekly",
      previousRemaining: 25,
      percentRemaining: 100,
      observedAt: now,
    });
    expect(event!.id).toMatch(/^[a-f0-9]{64}$/);
    expect(detectQuotaReset("openai", before(), after(), now)?.id).toBe(event!.id);
  });
  it.each([
    "unchanged",
    "consumption",
    "same-boundary",
    "missing-reset",
    "unknown-account",
    "account-switch",
    "window-switch",
    "same-observation",
    "expired-cache",
    "future-clock",
    "old-transition",
    "stale-source",
    "future-source",
    "future-baseline-source",
    "old-baseline",
    "rolling",
    "partial-reset",
    "untrusted-source",
  ])("does not infer reset from %s", (kind) => {
    const p = before(),
      c = after();
    if (kind === "unchanged") c.row.value = { kind: "percent", remaining: 25 };
    if (kind === "consumption") c.row.value = { kind: "percent", remaining: 20 };
    if (kind === "same-boundary") c.row.window = p.row.window;
    if (kind === "missing-reset") c.row.window = { kind: "identified", id: "weekly" };
    if (kind === "unknown-account") c.row.account = { kind: "unknown" };
    if (kind === "account-switch") c.row.account = { kind: "opaque", digest: "b".repeat(64) };
    if (kind === "window-switch")
      c.row.window = {
        kind: "identified",
        id: "monthly",
        resetTimeIso: new Date(now + 100000).toISOString(),
      };
    if (kind === "same-observation") c.observationId = p.observationId;
    if (kind === "expired-cache") c.observedAt = now - 6 * 60000;
    if (kind === "future-clock") c.observedAt = now + 1000;
    if (kind === "old-transition") {
      p.row.window = {
        kind: "identified",
        id: "weekly",
        resetTimeIso: new Date(now - 2 * 86400000).toISOString(),
      };
      p.observedAt = now - 3 * 86400000;
    }
    if (kind === "stale-source")
      c.row.freshness = { kind: "observed", observedAtIso: new Date(now - 5000).toISOString() };
    if (kind === "rolling")
      c.row.window = {
        kind: "rolling",
        id: "weekly",
        durationMs: 604800000,
        resetTimeIso: new Date(now + 604800000).toISOString(),
      };
    if (kind === "future-source")
      c.row.freshness = { kind: "observed", observedAtIso: new Date(now + 1000).toISOString() };
    if (kind === "future-baseline-source")
      p.row.freshness = { kind: "observed", observedAtIso: new Date(now).toISOString() };
    if (kind === "old-baseline") p.observedAt = now - 31 * 86400000;
    if (kind === "partial-reset")
      c.row.window = {
        kind: "fixed",
        id: "weekly",
        startedAtIso: new Date(now - 1000).toISOString(),
        endsAtIso: new Date(now + 604800000).toISOString(),
        fullReset: false,
      };
    if (kind === "untrusted-source") c.row.source.authority = "locally_derived";
    expect(detectQuotaReset("openai", p, c, now)).toBeNull();
  });
  it("does not notify before the boundary or infer from an already expired baseline", () => {
    expect(detectQuotaReset("openai", before(), after(), now - 3000)).toBeNull();
    const p = before();
    p.observedAt = now - 500;
    expect(detectQuotaReset("openai", p, after(), now)).toBeNull();
  });
});
