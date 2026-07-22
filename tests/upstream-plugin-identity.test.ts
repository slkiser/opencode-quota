import { describe, expect, it } from "vitest";

import {
  getTrackedUpstreamPluginIdentityDifferences,
  isTrackedUpstreamPluginInSync,
} from "../scripts/lib/upstream-plugin-identity.mjs";

const tracked = {
  version: "1.0.0",
  packageName: "example-plugin",
  repo: "owner/example-plugin",
  referenceDir: "references/upstream-plugins/example-plugin",
  npmUrl: "https://www.npmjs.com/package/example-plugin/v/1.0.0",
  publishedAt: "2026-07-01T00:00:00.000Z",
};

describe("upstream-plugin-identity", () => {
  it("reports identity differences in deterministic field order", () => {
    expect(
      getTrackedUpstreamPluginIdentityDifferences(tracked, {
        version: "2.0.0",
        packageName: "@scope/example-plugin",
        repo: "new-owner/example-plugin",
        referenceDir: "references/upstream-plugins/new-example-plugin",
        npmUrl: "https://www.npmjs.com/package/%40scope/example-plugin/v/2.0.0",
        publishedAt: "2026-07-22T00:00:00.000Z",
      }),
    ).toEqual(["version", "packageName", "repo", "referenceDir", "npmUrl", "publishedAt"]);
  });

  it("uses the same identity definition for the boolean in-sync check", () => {
    expect(isTrackedUpstreamPluginInSync(tracked, { ...tracked })).toBe(true);
    expect(
      isTrackedUpstreamPluginInSync(tracked, { ...tracked, repo: "other/example-plugin" }),
    ).toBe(false);
  });
});
