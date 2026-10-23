import { describe, expect, it } from "vite-plus/test";
import {
  getUpstreamPluginIssueTitle,
  getUpstreamPluginSpec,
  UPSTREAM_PLUGIN_REFERENCE_ROOT,
  UPSTREAM_PLUGIN_SPECS,
} from "../scripts/lib/upstream-plugin-specs.mjs";
import { CURSOR_CANONICAL_PLUGIN_PACKAGE } from "../src/lib/cursor-detection.js";

describe("upstream-plugin-specs", () => {
  it("tracks the expected upstream plugin ids", () => {
    expect(UPSTREAM_PLUGIN_SPECS.map((spec) => spec.pluginId)).toEqual([
      "cursor-opencode-provider",
      "opencode-gemini-auth",
      "opencode-agy-auth",
    ]);
  });

  it("builds the expected check issue titles", () => {
    expect(getUpstreamPluginIssueTitle("cursor-opencode-provider")).toBe(
      "[check] cursor-opencode-provider had update",
    );
  });

  it("stores references under the shared upstream plugin root", () => {
    for (const spec of UPSTREAM_PLUGIN_SPECS) {
      expect(spec.referenceDir).toBe(`${UPSTREAM_PLUGIN_REFERENCE_ROOT}/${spec.pluginId}`);
    }
  });

  it("tracks the Gemini CLI auth companion package and repo", () => {
    expect(getUpstreamPluginSpec("opencode-gemini-auth")).toMatchObject({
      distTag: "latest",
      packageName: "opencode-gemini-auth",
      pluginId: "opencode-gemini-auth",
      referenceDir: `${UPSTREAM_PLUGIN_REFERENCE_ROOT}/opencode-gemini-auth`,
      repo: "jenslys/opencode-gemini-auth",
    });
  });

  it("tracks the cursor-opencode-provider Cursor companion package and repo", () => {
    expect(getUpstreamPluginSpec("cursor-opencode-provider")).toMatchObject({
      distTag: "latest",
      packageName: "cursor-opencode-provider",
      pluginId: "cursor-opencode-provider",
      referenceDir: `${UPSTREAM_PLUGIN_REFERENCE_ROOT}/cursor-opencode-provider`,
      repo: "oakimov/cursor-opencode-provider",
    });
  });

  it("tracks the scoped Google AGY companion under a stable internal id", () => {
    expect(getUpstreamPluginSpec("opencode-agy-auth")).toMatchObject({
      distTag: "alpha",
      packageName: "@anthonyhaussman/opencode-agy-auth",
      pluginId: "opencode-agy-auth",
      referenceDir: `${UPSTREAM_PLUGIN_REFERENCE_ROOT}/opencode-agy-auth`,
      repo: "anthonyhaussman/opencode-agy-auth",
    });
    expect(getUpstreamPluginIssueTitle("opencode-agy-auth")).toBe(
      "[check] opencode-agy-auth had update",
    );
  });

  it("limits missing npm repository metadata to the verified AGY exception", () => {
    expect(getUpstreamPluginSpec("opencode-agy-auth")?.allowMissingRepositoryMetadata).toBe(true);
    expect(
      UPSTREAM_PLUGIN_SPECS.filter((spec) => spec.allowMissingRepositoryMetadata).map(
        (spec) => spec.pluginId,
      ),
    ).toEqual(["opencode-agy-auth"]);
  });

  it("keeps the runtime Cursor package name aligned with the upstream spec", () => {
    expect(getUpstreamPluginSpec("cursor-opencode-provider")?.packageName).toBe(
      CURSOR_CANONICAL_PLUGIN_PACKAGE,
    );
  });
});
