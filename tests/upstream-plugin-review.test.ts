import { describe, expect, it } from "vite-plus/test";

import {
  buildChangedPluginSummaries,
  buildUpstreamPluginReviewPrompt,
  getOmittedDiffPreview,
  groupReferenceChangesByPlugin,
  includeChangedReferencePluginSummaries,
  shouldOmitFullDiffPreview,
  shouldPrepareUpstreamPluginReview,
  trimDiffPreview,
} from "../scripts/lib/upstream-plugin-review.mjs";

describe("upstream-plugin-review", () => {
  it("builds changed plugin summaries from lock versions", () => {
    expect(
      buildChangedPluginSummaries(
        {
          plugins: {
            "opencode-gemini-auth": { version: "1.2.0" },
          },
        },
        {
          plugins: {
            "opencode-agy-auth": { version: "1.6.0" },
            "opencode-gemini-auth": { version: "1.3.0" },
          },
        },
      ),
    ).toEqual([
      {
        changeKind: "added",
        changedFields: ["version"],
        currentVersion: "1.6.0",
        pluginId: "opencode-agy-auth",
        previousVersion: null,
      },
      {
        changeKind: "version",
        changedFields: ["version"],
        currentVersion: "1.3.0",
        pluginId: "opencode-gemini-auth",
        previousVersion: "1.2.0",
      },
    ]);
  });

  it("detects same-version metadata-only changes", () => {
    const previous = {
      version: "0.4.3",
      packageName: "@old-scope/cursor-opencode-provider",
      repo: "old-owner/cursor-opencode-provider",
      referenceDir: "scripts/upstream-plugins/cursor-opencode-provider",
      npmUrl: "https://www.npmjs.com/package/%40old-scope/cursor-opencode-provider/v/0.4.3",
      publishedAt: "2026-04-08T14:04:58.057Z",
    };
    const current = {
      ...previous,
      packageName: "cursor-opencode-provider",
      repo: "oakimov/cursor-opencode-provider",
    };

    expect(
      buildChangedPluginSummaries(
        { plugins: { "cursor-opencode-provider": previous } },
        { plugins: { "cursor-opencode-provider": current } },
      ),
    ).toEqual([
      {
        changeKind: "metadata",
        changedFields: ["packageName", "repo"],
        currentVersion: "0.4.3",
        pluginId: "cursor-opencode-provider",
        previousVersion: "0.4.3",
      },
    ]);
  });

  it("keeps pre-synchronized reference-only changes in the review set", () => {
    const lock = {
      plugins: {
        "cursor-opencode-provider": {
          version: "0.4.3",
        },
      },
    };

    expect(
      includeChangedReferencePluginSummaries(
        lock,
        lock,
        new Map([
          [
            "cursor-opencode-provider",
            ["scripts/upstream-plugins/cursor-opencode-provider/package.json"],
          ],
        ]),
        [],
      ),
    ).toEqual([
      {
        changeKind: "metadata",
        changedFields: ["reference contents"],
        currentVersion: "0.4.3",
        pluginId: "cursor-opencode-provider",
        previousVersion: "0.4.3",
      },
    ]);
  });

  it("does not allow the coordinator to exit while identity or reference changes remain", () => {
    expect(
      shouldPrepareUpstreamPluginReview(
        [
          {
            changeKind: "metadata",
            changedFields: ["packageName"],
            currentVersion: "0.4.3",
            pluginId: "cursor-opencode-provider",
            previousVersion: "0.4.3",
          },
        ],
        [],
      ),
    ).toBe(true);
    expect(
      shouldPrepareUpstreamPluginReview(
        [],
        [
          {
            path: "scripts/upstream-plugins/lock.json",
            status: " M",
          },
        ],
      ),
    ).toBe(true);
    expect(shouldPrepareUpstreamPluginReview([], [])).toBe(false);
  });

  it("groups changed reference files by plugin", () => {
    const grouped = groupReferenceChangesByPlugin([
      "scripts/upstream-plugins/opencode-gemini-auth/package.json",
      "scripts/upstream-plugins/opencode-gemini-auth/src/index.ts",
      "scripts/upstream-plugins/opencode-agy-auth/dist/index.js",
      "scripts/upstream-plugins/lock.json",
    ]);

    expect(grouped.get("opencode-gemini-auth")).toEqual([
      "scripts/upstream-plugins/opencode-gemini-auth/package.json",
      "scripts/upstream-plugins/opencode-gemini-auth/src/index.ts",
    ]);
    expect(grouped.get("opencode-agy-auth")).toEqual([
      "scripts/upstream-plugins/opencode-agy-auth/dist/index.js",
    ]);
  });

  it("omits generated source map previews", () => {
    expect(
      shouldOmitFullDiffPreview("scripts/upstream-plugins/opencode-agy-auth/dist/index.js.map"),
    ).toBe(true);
    expect(
      shouldOmitFullDiffPreview("scripts/upstream-plugins/opencode-agy-auth/dist/index.js"),
    ).toBe(false);
    expect(getOmittedDiffPreview()).toContain("generated source map diff omitted");
  });

  it("limits large single-line diff previews by character count", () => {
    const preview = trimDiffPreview(`+${"x".repeat(200)}`, 80, 40);

    expect(preview.truncated).toBe(true);
    expect(preview.text).toBe(`+${"x".repeat(39)}\n... diff truncated ...`);
  });

  it("prioritizes readable previews over generated source maps", () => {
    const pluginId = "opencode-agy-auth";
    const readablePath = `scripts/upstream-plugins/${pluginId}/package.json`;
    const sourceMapPaths = ["a.js.map", "b.js.map", "c.js.map", "d.js.map"].map(
      (fileName) => `scripts/upstream-plugins/${pluginId}/dist/${fileName}`,
    );
    const prompt = buildUpstreamPluginReviewPrompt({
      changedFilesByPlugin: new Map([[pluginId, [...sourceMapPaths, readablePath]]]),
      changedPlugins: [
        {
          changeKind: "version",
          changedFields: ["version"],
          currentVersion: "1.1.7",
          pluginId,
          previousVersion: "1.1.6",
        },
      ],
      diffPreviewByPath: new Map([[readablePath, "+readable change"]]),
      testResult: { command: "pnpm test", exitCode: 0, ok: true, output: "" },
      typecheckResult: {
        command: "pnpm run typecheck",
        exitCode: 0,
        ok: true,
        output: "",
      },
    });

    expect(prompt).toContain("+readable change");
    expect(prompt).toContain("4 generated source map diff previews omitted");
  });

  it("builds a ready-to-paste review prompt with paths, diffs, and check results", () => {
    const prompt = buildUpstreamPluginReviewPrompt({
      changedFilesByPlugin: new Map([
        [
          "opencode-gemini-auth",
          [
            "scripts/upstream-plugins/opencode-gemini-auth/package.json",
            "scripts/upstream-plugins/opencode-gemini-auth/src/index.ts",
          ],
        ],
      ]),
      changedPlugins: [
        {
          changeKind: "version",
          changedFields: ["version"],
          currentVersion: "1.3.0",
          pluginId: "opencode-gemini-auth",
          previousVersion: "1.2.0",
        },
      ],
      diffPreviewByPath: new Map([
        [
          "scripts/upstream-plugins/opencode-gemini-auth/package.json",
          '--- a/scripts/upstream-plugins/opencode-gemini-auth/package.json\n+++ b/scripts/upstream-plugins/opencode-gemini-auth/package.json\n@@\n-  "version": "1.2.0"\n+  "version": "1.3.0"',
        ],
      ]),
      testResult: {
        command: "pnpm test",
        exitCode: 0,
        ok: true,
        output: "",
      },
      typecheckResult: {
        command: "pnpm run typecheck",
        exitCode: 1,
        ok: false,
        output: "Type error here",
      },
    });

    expect(prompt).toContain("Please check whether these upstream plugin updates conflict");
    expect(prompt).toContain("opencode-gemini-auth: 1.2.0 -> 1.3.0");
    expect(
      buildUpstreamPluginReviewPrompt({
        changedFilesByPlugin: new Map(),
        changedPlugins: [
          {
            changeKind: "metadata",
            changedFields: ["packageName", "repo"],
            currentVersion: "0.4.3",
            pluginId: "cursor-opencode-provider",
            previousVersion: "0.4.3",
          },
        ],
        diffPreviewByPath: new Map(),
        testResult: { command: "pnpm test", exitCode: 0, ok: true, output: "" },
        typecheckResult: {
          command: "pnpm run typecheck",
          exitCode: 0,
          ok: true,
          output: "",
        },
      }),
    ).toContain("cursor-opencode-provider: metadata changed at 0.4.3 (packageName, repo)");
    expect(prompt).toContain("scripts/upstream-plugins/opencode-gemini-auth/package.json");
    expect(prompt).toContain('"version": "1.3.0"');
    expect(prompt).toContain("`pnpm test`: passed");
    expect(prompt).toContain("`pnpm run typecheck`: failed");
    expect(prompt).toContain("Type error here");
  });
});
