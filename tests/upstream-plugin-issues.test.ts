import { describe, expect, it } from "vite-plus/test";

import {
  buildUpstreamPluginIssueBody,
  planUpstreamPluginIssueAction,
  UPSTREAM_PLUGIN_ISSUE_STATE,
} from "../scripts/lib/upstream-plugin-issues.mjs";
import { getUpstreamPluginSpec } from "../scripts/lib/upstream-plugin-specs.mjs";

const spec = getUpstreamPluginSpec("opencode-gemini-auth");

const tracked = {
  npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/1.2.0",
  packageName: "opencode-gemini-auth",
  publishedAt: "2026-03-01T00:00:00.000Z",
  referenceDir: "scripts/upstream-plugins/opencode-gemini-auth",
  repo: "jenslys/opencode-gemini-auth",
  version: "1.2.0",
};

const BOT = { login: "github-actions[bot]" };

const latest = {
  ...tracked,
  npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/1.3.0",
  publishedAt: "2026-03-20T00:00:00.000Z",
  version: "1.3.0",
};

describe("upstream-plugin-issues", () => {
  it("builds issue bodies with the review-prep command and machine markers", () => {
    const body = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest,
      spec,
      tracked,
    });

    expect(body).toContain("pnpm run upstream:prepare-review");
    expect(body).toContain("<!-- opencode-quota:plugin=opencode-gemini-auth -->");
    expect(body).toContain("<!-- opencode-quota:issue-state=update_available -->");
    expect(body).toContain("<!-- opencode-quota:latest-version=1.3.0 -->");
  });

  it("uses the Cursor companion package and repo in issue details", () => {
    const cursorSpec = getUpstreamPluginSpec("cursor-opencode-provider");
    expect(cursorSpec).toBeTruthy();
    if (!cursorSpec) return;

    const cursorTracked = {
      npmUrl: "https://www.npmjs.com/package/cursor-opencode-provider/v/0.7.3",
      packageName: "cursor-opencode-provider",
      publishedAt: "2026-09-20T10:00:00.000Z",
      referenceDir: "scripts/upstream-plugins/cursor-opencode-provider",
      repo: "oakimov/cursor-opencode-provider",
      version: "0.7.3",
    };

    const body = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest: cursorTracked,
      spec: cursorSpec,
      tracked: cursorTracked,
    });

    expect(body).toContain("- Plugin: `cursor-opencode-provider`");
    expect(body).toContain("- Package: `cursor-opencode-provider`");
    expect(body).toContain("- Repository: `oakimov/cursor-opencode-provider`");
    expect(body).toContain("- Reference path: `scripts/upstream-plugins/cursor-opencode-provider`");
  });

  it("uses the canonical scoped AGY package and repository in issue details", () => {
    const agySpec = getUpstreamPluginSpec("opencode-agy-auth");
    expect(agySpec).toBeTruthy();
    if (!agySpec) return;

    const agyTracked = {
      npmUrl: "https://www.npmjs.com/package/%40anthonyhaussman/opencode-agy-auth/v/1.1.4",
      packageName: "@anthonyhaussman/opencode-agy-auth",
      publishedAt: "2026-07-18T08:36:49.202Z",
      referenceDir: "scripts/upstream-plugins/opencode-agy-auth",
      repo: "anthonyhaussman/opencode-agy-auth",
      version: "1.1.4",
    };

    const body = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest: agyTracked,
      spec: agySpec,
      tracked: agyTracked,
    });

    expect(body).toContain("- Plugin: `opencode-agy-auth`");
    expect(body).toContain("- Package: `@anthonyhaussman/opencode-agy-auth`");
    expect(body).toContain("- Repository: `anthonyhaussman/opencode-agy-auth`");
  });

  it("treats same-version Cursor metadata drift as an available update", () => {
    const cursorSpec = getUpstreamPluginSpec("cursor-opencode-provider");
    expect(cursorSpec).toBeTruthy();
    if (!cursorSpec) return;

    const trackedCursor = {
      npmUrl: "https://www.npmjs.com/package/cursor-opencode-provider/v/0.7.3",
      packageName: "cursor-opencode-provider",
      publishedAt: "2026-09-20T10:00:00.000Z",
      referenceDir: "scripts/upstream-plugins/cursor-opencode-provider",
      repo: "old-owner/cursor-opencode-provider",
      version: "0.7.3",
    };

    const latestCursor = {
      ...trackedCursor,
      repo: "oakimov/cursor-opencode-provider",
    };

    const plan = planUpstreamPluginIssueAction({
      existingIssues: [],
      latest: latestCursor,
      spec: cursorSpec,
      tracked: trackedCursor,
    });

    expect(plan.create).toMatchObject({
      title: "[check] cursor-opencode-provider had update",
    });
    expect(plan.create?.body).toContain("<!-- opencode-quota:issue-state=update_available -->");
  });

  it("creates an issue when same-version npm metadata drifts", () => {
    const sameVersionLatest = {
      ...tracked,
      npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/1.2.0?activeTab=versions",
      publishedAt: "2026-03-02T00:00:00.000Z",
    };

    const plan = planUpstreamPluginIssueAction({
      existingIssues: [],
      latest: sameVersionLatest,
      spec,
      tracked,
    });

    expect(plan.create).toMatchObject({
      title: "[check] opencode-gemini-auth had update",
    });
    expect(plan.create?.body).toContain("<!-- opencode-quota:issue-state=update_available -->");
  });

  it("creates an issue when the tracked copy is behind and no open issue exists", () => {
    const plan = planUpstreamPluginIssueAction({
      existingIssues: [],
      latest,
      spec,
      tracked,
    });

    expect(plan.create).toMatchObject({
      title: "[check] opencode-gemini-auth had update",
    });
    expect(plan.comments).toEqual([]);
    expect(plan.update).toBeNull();
    expect(plan.close).toEqual([]);
  });

  it("stays quiet when an issue for the same npm version was closed", () => {
    const closedBody = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest,
      spec,
      tracked,
    });

    const plan = planUpstreamPluginIssueAction({
      closedIssues: [{ body: closedBody, number: 7, user: BOT }],
      existingIssues: [],
      latest,
      spec,
      tracked,
    });

    expect(plan.create).toBeNull();
    expect(plan.update).toBeNull();
    expect(plan.comments).toEqual([]);
    expect(plan.close).toEqual([]);
  });

  it("stays quiet for a closed issue whose body was saved with CRLF line endings", () => {
    const closedBody = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest,
      spec,
      tracked,
    }).replace(/\n/gu, "\r\n");

    const plan = planUpstreamPluginIssueAction({
      closedIssues: [{ body: closedBody, number: 7, user: BOT }],
      existingIssues: [],
      latest,
      spec,
      tracked,
    });

    expect(plan.create).toBeNull();
  });

  it("stays quiet for a closed issue that names an older reference path", () => {
    const closedBody = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest,
      spec,
      tracked,
    }).replace(
      "- Reference path: `scripts/upstream-plugins/opencode-gemini-auth`",
      "- Reference path: `references/upstream-plugins/opencode-gemini-auth`",
    );
    expect(closedBody).toContain("`references/upstream-plugins/opencode-gemini-auth`");

    const plan = planUpstreamPluginIssueAction({
      closedIssues: [{ body: closedBody, number: 7, user: BOT }],
      existingIssues: [],
      latest,
      spec,
      tracked,
    });

    expect(plan.create).toBeNull();
  });

  it("opens a new issue when npm publishes a newer version after a closed one", () => {
    const olderBody = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest,
      spec,
      tracked,
    });
    const newer = {
      ...latest,
      npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/1.4.0",
      publishedAt: "2026-04-01T00:00:00.000Z",
      version: "1.4.0",
    };
    const otherPluginBody = olderBody.replace(
      "opencode-quota:plugin=opencode-gemini-auth",
      "opencode-quota:plugin=opencode-agy-auth",
    );

    const plan = planUpstreamPluginIssueAction({
      closedIssues: [
        { body: olderBody, number: 7, user: BOT },
        {
          body: otherPluginBody.replace("latest-version=1.3.0", "latest-version=1.4.0"),
          number: 8,
          user: BOT,
        },
      ],
      existingIssues: [],
      latest: newer,
      spec,
      tracked,
    });

    expect(plan.create).toMatchObject({ title: "[check] opencode-gemini-auth had update" });
    expect(plan.create?.body).toContain("<!-- opencode-quota:latest-version=1.4.0 -->");
  });

  it("opens a new issue when a closed release is republished with other details", () => {
    const closedBody = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest,
      spec,
      tracked,
    });

    const plan = planUpstreamPluginIssueAction({
      closedIssues: [{ body: closedBody, number: 7, user: BOT }],
      existingIssues: [],
      latest: { ...latest, publishedAt: "2026-03-21T00:00:00.000Z" },
      spec,
      tracked,
    });

    expect(plan.create).toMatchObject({ title: "[check] opencode-gemini-auth had update" });
  });

  it("ignores closed issues that this workflow did not open", () => {
    const copiedBody = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest,
      spec,
      tracked,
    });

    const plan = planUpstreamPluginIssueAction({
      closedIssues: [{ body: copiedBody, number: 7, user: { login: "someone" } }],
      existingIssues: [],
      latest,
      spec,
      tracked,
    });

    expect(plan.create).toMatchObject({ title: "[check] opencode-gemini-auth had update" });
  });

  it("treats an issue closed during the run as closed, never updating it", () => {
    const olderLatest = { ...latest, version: "1.2.5", publishedAt: "2026-03-10T00:00:00.000Z" };
    const closedDuringRun = {
      body: buildUpstreamPluginIssueBody({
        issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
        latest: olderLatest,
        spec,
        tracked,
      }),
      number: 7,
      user: BOT,
    };

    const plan = planUpstreamPluginIssueAction({
      closedIssues: [closedDuringRun],
      existingIssues: [closedDuringRun],
      latest,
      spec,
      tracked,
    });

    expect(plan.update).toBeNull();
    expect(plan.comments).toEqual([]);
    expect(plan.create).toMatchObject({ title: "[check] opencode-gemini-auth had update" });
  });

  it("updates the canonical issue, comments on newer releases, and closes duplicates", () => {
    const previousLatest = {
      ...tracked,
      npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/1.2.5",
      publishedAt: "2026-03-10T00:00:00.000Z",
      version: "1.2.5",
    };

    const plan = planUpstreamPluginIssueAction({
      existingIssues: [
        {
          body: buildUpstreamPluginIssueBody({
            issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
            latest: previousLatest,
            spec,
            tracked,
          }),
          number: 23,
          title: "[check] opencode-gemini-auth had update",
        },
        {
          body: buildUpstreamPluginIssueBody({
            issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
            latest: previousLatest,
            spec,
            tracked,
          }),
          number: 31,
          title: "[check] opencode-gemini-auth had update",
        },
      ],
      latest,
      spec,
      tracked,
    });

    expect(plan.create).toBeNull();
    expect(plan.update).toMatchObject({ issueNumber: 23 });
    expect(plan.comments).toEqual([
      {
        body: "Newer upstream npm release detected for opencode-gemini-auth: 1.2.5 -> 1.3.0.",
        issueNumber: 23,
      },
    ]);
    expect(plan.close).toEqual([
      {
        commentBody:
          "Closing as duplicate of #23. The tracked reference is still behind npm 1.3.0.",
        issueNumber: 31,
      },
    ]);
  });

  it("ignores same-title issues that do not contain workflow markers", () => {
    const plan = planUpstreamPluginIssueAction({
      existingIssues: [
        {
          body: "Manually tracked by a maintainer.",
          number: 52,
          title: "[check] opencode-gemini-auth had update",
        },
      ],
      latest,
      spec,
      tracked,
    });

    expect(plan.create).toMatchObject({
      title: "[check] opencode-gemini-auth had update",
    });
    expect(plan.comments).toEqual([]);
    expect(plan.update).toBeNull();
    expect(plan.close).toEqual([]);
  });

  it("keeps the issue open when the tracked version catches up", () => {
    const plan = planUpstreamPluginIssueAction({
      existingIssues: [
        {
          body: buildUpstreamPluginIssueBody({
            issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
            latest,
            spec,
            tracked,
          }),
          number: 45,
          title: "[check] opencode-gemini-auth had update",
        },
      ],
      latest: tracked,
      spec,
      tracked,
    });

    expect(plan.create).toBeNull();
    expect(plan.comments).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(plan.update).toMatchObject({ issueNumber: 45 });
    expect(plan.update?.body).toContain("synced_pending_review");
  });

  it("does nothing when there is no open issue and the tracked version already matches npm", () => {
    const plan = planUpstreamPluginIssueAction({
      existingIssues: [],
      latest: tracked,
      spec,
      tracked,
    });

    expect(plan.create).toBeNull();
    expect(plan.comments).toEqual([]);
    expect(plan.update).toBeNull();
    expect(plan.close).toEqual([]);
  });
});
