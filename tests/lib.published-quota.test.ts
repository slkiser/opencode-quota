import { describe, expect, it, vi } from "vite-plus/test";
import { createPublishedQuota } from "../src/lib/published-quota.js";
import { validateQuotaProviders } from "../src/lib/quota-providers.js";

const publication = {
  version: "quota-v1",
  entries: [{ kind: "percent", name: "monthly", resultType: "quota", percentRemaining: 25 }],
};

describe("published quota", () => {
  it("is an opt-in custom source with no URL or credentials", () => {
    const input = { id: "sample", mode: "published" };
    expect(validateQuotaProviders([input]).value).toMatchObject([input]);
    expect(validateQuotaProviders([{ ...input, url: "https://example.com" }]).issues).not.toEqual(
      [],
    );
  });

  it("reads only valid snapshots, until withdrawn or expired", () => {
    let now = 0;
    const quota = createPublishedQuota(() => now);
    quota.reconcile(["alpha"]);
    const publish = (body: unknown) => quota.publish("alpha", quota.probe("alpha"), body);
    expect(publish(publication)).toBe(true);
    expect(publish({ ...publication, entries: [{}] })).toBe(false);
    expect(quota.read("alpha")).toMatchObject({ rows: [{ percentRemaining: 25 }] });
    expect(quota.read("beta")).toBeUndefined();
    expect(publish({ version: "quota-v1", entries: [] })).toBe(true);
    expect(quota.read("alpha")).toBeUndefined();
    publish(publication);
    now += 120_000;
    expect(quota.read("alpha")).toBeUndefined();
    quota.clear();
  });

  it("rejects older, disabled, and pre-switch publication tickets", () => {
    const quota = createPublishedQuota();
    quota.reconcile(["alpha", "beta"]);
    const old = quota.probe("alpha");
    const newer = quota.probe("alpha");
    expect(quota.publish("alpha", old, publication)).toBe(false);
    expect(quota.publish("beta", newer, publication)).toBe(false);
    expect(quota.publish("alpha", newer, publication)).toBe(true);
    quota.clear();
    expect(quota.read("alpha")).toBeUndefined();
    expect(quota.publish("alpha", newer, publication)).toBe(false);
    const enabled = quota.probe("alpha");
    quota.reconcile(["beta"]);
    expect(quota.probe("alpha")).toBeUndefined();
    quota.reconcile(["alpha", "beta"]);
    expect(quota.publish("alpha", enabled, publication)).toBe(false);
  });

  it("notifies an open view when a publication expires without another request", () => {
    vi.useFakeTimers();
    try {
      const changed = vi.fn();
      const quota = createPublishedQuota(Date.now, changed);
      quota.reconcile(["alpha"]);
      quota.publish("alpha", quota.probe("alpha"), publication);
      changed.mockClear();
      vi.advanceTimersByTime(120_000);
      expect(quota.read("alpha")).toBeUndefined();
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
