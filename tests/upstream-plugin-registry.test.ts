import { describe, expect, it } from "vitest";

import { normalizeLatestPublishedPluginVersion } from "../scripts/lib/upstream-plugin-registry.mjs";
import { getUpstreamPluginSpec } from "../scripts/lib/upstream-plugin-specs.mjs";

describe("upstream-plugin-registry", () => {
  it("builds canonical npm metadata for the scoped Cursor package", () => {
    const spec = getUpstreamPluginSpec("opencode-cursor-oauth");
    expect(spec).toBeTruthy();
    if (!spec) return;

    const latest = normalizeLatestPublishedPluginVersion(spec, {
      "dist-tags": {
        latest: "0.4.3",
      },
      repository: {
        type: "git",
        url: "git+https://github.com/PoolPirate/opencode-cursor.git",
      },
      time: {
        "0.4.3": "2026-04-08T14:04:58.057Z",
      },
      versions: {
        "0.4.3": {
          dist: {
            tarball:
              "https://example.test/@playwo/opencode-cursor-oauth/-/opencode-cursor-oauth-0.4.3.tgz",
          },
          repository: {
            type: "git",
            url: "git+https://github.com/PoolPirate/opencode-cursor.git",
          },
        },
      },
    });

    expect(latest.packageName).toBe("@playwo/opencode-cursor-oauth");
    expect(latest.repo).toBe("PoolPirate/opencode-cursor");
    expect(latest.npmUrl).toBe(
      "https://www.npmjs.com/package/%40playwo/opencode-cursor-oauth/v/0.4.3",
    );
  });

  it("rejects missing repository metadata without an explicit spec exception", () => {
    const spec = getUpstreamPluginSpec("opencode-cursor-oauth");
    expect(spec).toBeTruthy();
    if (!spec) return;

    expect(() =>
      normalizeLatestPublishedPluginVersion(spec, {
        "dist-tags": { latest: "0.4.3" },
        time: { "0.4.3": "2026-04-08T14:04:58.057Z" },
        versions: {
          "0.4.3": {
            dist: {
              tarball:
                "https://example.test/@playwo/opencode-cursor-oauth/-/opencode-cursor-oauth-0.4.3.tgz",
            },
          },
        },
      }),
    ).toThrow("is missing GitHub repository metadata");
  });

  it("builds canonical npm metadata for scoped AGY when npm omits repository metadata", () => {
    const spec = getUpstreamPluginSpec("opencode-agy-auth");
    expect(spec).toBeTruthy();
    if (!spec) return;

    const latest = normalizeLatestPublishedPluginVersion(spec, {
      "dist-tags": { latest: "1.1.4" },
      time: { "1.1.4": "2026-07-18T08:36:49.202Z" },
      versions: {
        "1.1.4": {
          dist: {
            tarball:
              "https://registry.npmjs.org/@anthonyhaussman/opencode-agy-auth/-/opencode-agy-auth-1.1.4.tgz",
          },
        },
      },
    });

    expect(latest.packageName).toBe("@anthonyhaussman/opencode-agy-auth");
    expect(latest.repo).toBe("anthonyhaussman/opencode-agy-auth");
    expect(latest.npmUrl).toBe(
      "https://www.npmjs.com/package/%40anthonyhaussman/opencode-agy-auth/v/1.1.4",
    );
  });

  it("rejects malformed non-empty repository metadata for the AGY exception", () => {
    const spec = getUpstreamPluginSpec("opencode-agy-auth");
    expect(spec).toBeTruthy();
    if (!spec) return;

    expect(() =>
      normalizeLatestPublishedPluginVersion(spec, {
        "dist-tags": { latest: "1.1.4" },
        repository: "https://gitlab.com/anthonyhaussman/opencode-agy-auth",
        time: { "1.1.4": "2026-07-18T08:36:49.202Z" },
        versions: {
          "1.1.4": {
            dist: {
              tarball:
                "https://registry.npmjs.org/@anthonyhaussman/opencode-agy-auth/-/opencode-agy-auth-1.1.4.tgz",
            },
          },
        },
      }),
    ).toThrow("has non-empty repository metadata that is not a GitHub repository");
  });

  it("rejects conflicting repository metadata even for the AGY exception", () => {
    const spec = getUpstreamPluginSpec("opencode-agy-auth");
    expect(spec).toBeTruthy();
    if (!spec) return;

    expect(() =>
      normalizeLatestPublishedPluginVersion(spec, {
        "dist-tags": { latest: "1.1.4" },
        repository: "github:someone-else/opencode-agy-auth",
        time: { "1.1.4": "2026-07-18T08:36:49.202Z" },
        versions: {
          "1.1.4": {
            dist: {
              tarball:
                "https://registry.npmjs.org/@anthonyhaussman/opencode-agy-auth/-/opencode-agy-auth-1.1.4.tgz",
            },
          },
        },
      }),
    ).toThrow(
      "points to someone-else/opencode-agy-auth, but this repo expects anthonyhaussman/opencode-agy-auth",
    );
  });
});
