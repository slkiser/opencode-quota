import { describe, expect, it } from "vite-plus/test";

import { normalizeLatestPublishedPluginVersion } from "../scripts/lib/upstream-plugin-registry.mjs";
import { getUpstreamPluginSpec } from "../scripts/lib/upstream-plugin-specs.mjs";

describe("upstream-plugin-registry", () => {
  it("builds canonical npm metadata for the Cursor package", () => {
    const spec = getUpstreamPluginSpec("cursor-opencode-provider");
    expect(spec).toBeTruthy();
    if (!spec) return;

    const latest = normalizeLatestPublishedPluginVersion(spec, {
      "dist-tags": {
        latest: "0.7.3",
      },
      repository: {
        type: "git",
        url: "git+https://github.com/oakimov/cursor-opencode-provider.git",
      },
      time: {
        "0.7.3": "2026-09-20T10:00:00.000Z",
      },
      versions: {
        "0.7.3": {
          dist: {
            tarball:
              "https://registry.npmjs.org/cursor-opencode-provider/-/cursor-opencode-provider-0.7.3.tgz",
          },
          repository: {
            type: "git",
            url: "git+https://github.com/oakimov/cursor-opencode-provider.git",
          },
        },
      },
    });

    expect(latest.packageName).toBe("cursor-opencode-provider");
    expect(latest.repo).toBe("oakimov/cursor-opencode-provider");
    expect(latest.version).toBe("0.7.3");
    expect(latest.npmUrl).toBe("https://www.npmjs.com/package/cursor-opencode-provider/v/0.7.3");
  });

  it("rejects missing repository metadata without an explicit spec exception", () => {
    const spec = getUpstreamPluginSpec("cursor-opencode-provider");
    expect(spec).toBeTruthy();
    if (!spec) return;

    expect(() =>
      normalizeLatestPublishedPluginVersion(spec, {
        "dist-tags": { latest: "0.7.3" },
        time: { "0.7.3": "2026-09-20T10:00:00.000Z" },
        versions: {
          "0.7.3": {
            dist: {
              tarball:
                "https://registry.npmjs.org/cursor-opencode-provider/-/cursor-opencode-provider-0.7.3.tgz",
            },
          },
        },
      }),
    ).toThrow("is missing GitHub repository metadata");
  });

  it("tracks the AGY alpha dist-tag, not latest", () => {
    const spec = getUpstreamPluginSpec("opencode-agy-auth");
    expect(spec).toBeTruthy();
    if (!spec) return;

    const latest = normalizeLatestPublishedPluginVersion(spec, {
      "dist-tags": { alpha: "1.2.11-alpha.0", latest: "1.2.11" },
      time: {
        "1.2.11": "2026-09-25T06:33:34.440Z",
        "1.2.11-alpha.0": "2026-09-25T06:34:38.610Z",
      },
      versions: {
        "1.2.11": {
          dist: {
            tarball:
              "https://registry.npmjs.org/@anthonyhaussman/opencode-agy-auth/-/opencode-agy-auth-1.2.11.tgz",
          },
        },
        "1.2.11-alpha.0": {
          dist: {
            tarball:
              "https://registry.npmjs.org/@anthonyhaussman/opencode-agy-auth/-/opencode-agy-auth-1.2.11-alpha.0.tgz",
          },
        },
      },
    });

    expect(latest.version).toBe("1.2.11-alpha.0");
    expect(latest.tarballUrl).toBe(
      "https://registry.npmjs.org/@anthonyhaussman/opencode-agy-auth/-/opencode-agy-auth-1.2.11-alpha.0.tgz",
    );
    expect(latest.npmUrl).toBe(
      "https://www.npmjs.com/package/%40anthonyhaussman/opencode-agy-auth/v/1.2.11-alpha.0",
    );
  });

  it("rejects a packument without the tracked dist-tag", () => {
    const spec = getUpstreamPluginSpec("opencode-agy-auth");
    expect(spec).toBeTruthy();
    if (!spec) return;

    expect(() =>
      normalizeLatestPublishedPluginVersion(spec, {
        "dist-tags": { latest: "1.2.11" },
        time: { "1.2.11": "2026-09-25T06:33:34.440Z" },
        versions: {
          "1.2.11": {
            dist: {
              tarball:
                "https://registry.npmjs.org/@anthonyhaussman/opencode-agy-auth/-/opencode-agy-auth-1.2.11.tgz",
            },
          },
        },
      }),
    ).toThrow("is missing the alpha dist-tag");
  });

  it("builds canonical npm metadata for scoped AGY when npm omits repository metadata", () => {
    const spec = getUpstreamPluginSpec("opencode-agy-auth");
    expect(spec).toBeTruthy();
    if (!spec) return;

    const latest = normalizeLatestPublishedPluginVersion(spec, {
      "dist-tags": { alpha: "1.1.4" },
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
        "dist-tags": { alpha: "1.1.4" },
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
        "dist-tags": { alpha: "1.1.4" },
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
