import { describe, expect, it } from "vite-plus/test";
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
    expect(quota.publish("alpha", publication)).toBe(true);
    expect(quota.publish("alpha", { ...publication, entries: [{}] })).toBe(false);
    expect(quota.read("alpha")).toMatchObject([{ percentRemaining: 25 }]);
    expect(quota.read("beta")).toBeUndefined();
    expect(quota.publish("alpha", { version: "quota-v1", entries: [] })).toBe(true);
    expect(quota.read("alpha")).toBeUndefined();
    quota.publish("alpha", publication);
    now += 120_000;
    expect(quota.read("alpha")).toBeUndefined();
  });
});
