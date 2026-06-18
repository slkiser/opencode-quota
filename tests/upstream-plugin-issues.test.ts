import { describe, expect, it } from "vitest";

import {
  buildUpstreamPluginIssueBody,
  planUpstreamPluginIssueAction,
  UPSTREAM_PLUGIN_ISSUE_STATE,
} from "../scripts/lib/upstream-plugin-issues.mjs";
import { getUpstreamPluginSpec } from "../scripts/lib/upstream-plugin-specs.mjs";

const spec = getUpstreamPluginSpec("opencode-qwencode-auth");

const tracked = {
  npmUrl: "https://www.npmjs.com/package/opencode-qwencode-auth/v/1.2.0",
  packageName: "opencode-qwencode-auth",
  publishedAt: "2026-03-01T00:00:00.000Z",
  referenceDir: "references/upstream-plugins/opencode-qwencode-auth",
  repo: "gustavodiasdev/opencode-qwencode-auth",
  version: "1.2.0",
};

const latest = {
  ...tracked,
  npmUrl: "https://www.npmjs.com/package/opencode-qwencode-auth/v/1.3.0",
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
    expect(body).toContain("<!-- opencode-quota:plugin=opencode-qwencode-auth -->");
    expect(body).toContain("<!-- opencode-quota:issue-state=update_available -->");
    expect(body).toContain("<!-- opencode-quota:latest-version=1.3.0 -->");
  });

  it("uses the canonical Cursor package and repo while keeping the internal tracked key stable", () => {
    const cursorSpec = getUpstreamPluginSpec("opencode-cursor-oauth");
    expect(cursorSpec).toBeTruthy();
    if (!cursorSpec) return;

    const cursorTracked = {
      npmUrl: "https://www.npmjs.com/package/%40playwo/opencode-cursor-oauth/v/0.4.3",
      packageName: "@playwo/opencode-cursor-oauth",
      publishedAt: "2026-04-08T14:04:58.057Z",
      referenceDir: "references/upstream-plugins/opencode-cursor-oauth",
      repo: "PoolPirate/opencode-cursor",
      version: "0.4.3",
    };

    const body = buildUpstreamPluginIssueBody({
      issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
      latest: cursorTracked,
      spec: cursorSpec,
      tracked: cursorTracked,
    });

    expect(body).toContain("- Plugin: `opencode-cursor-oauth`");
    expect(body).toContain("- Package: `@playwo/opencode-cursor-oauth`");
    expect(body).toContain("- Repository: `PoolPirate/opencode-cursor`");
    expect(body).toContain("- Reference path: `references/upstream-plugins/opencode-cursor-oauth`");
  });

  it("treats same-version Cursor metadata drift as an available update", () => {
    const cursorSpec = getUpstreamPluginSpec("opencode-cursor-oauth");
    expect(cursorSpec).toBeTruthy();
    if (!cursorSpec) return;

    const trackedCursor = {
      npmUrl: "https://www.npmjs.com/package/opencode-cursor-oauth/v/0.4.3",
      packageName: "opencode-cursor-oauth",
      publishedAt: "2026-04-08T14:04:58.057Z",
      referenceDir: "references/upstream-plugins/opencode-cursor-oauth",
      repo: "ephraimduncan/opencode-cursor",
      version: "0.4.3",
    };

    const latestCursor = {
      npmUrl: "https://www.npmjs.com/package/%40playwo/opencode-cursor-oauth/v/0.4.3",
      packageName: "@playwo/opencode-cursor-oauth",
      publishedAt: "2026-04-08T14:04:58.057Z",
      referenceDir: "references/upstream-plugins/opencode-cursor-oauth",
      repo: "PoolPirate/opencode-cursor",
      version: "0.4.3",
    };

    const plan = planUpstreamPluginIssueAction({
      existingIssues: [],
      latest: latestCursor,
      spec: cursorSpec,
      tracked: trackedCursor,
    });

    expect(plan.create).toMatchObject({
      title: "[check] opencode-cursor-oauth had update",
    });
    expect(plan.create?.body).toContain("<!-- opencode-quota:issue-state=update_available -->");
  });

  it("creates an issue when same-version npm metadata drifts", () => {
    const sameVersionLatest = {
      ...tracked,
      npmUrl: "https://www.npmjs.com/package/opencode-qwencode-auth/v/1.2.0?activeTab=versions",
      publishedAt: "2026-03-02T00:00:00.000Z",
    };

    const plan = planUpstreamPluginIssueAction({
      existingIssues: [],
      latest: sameVersionLatest,
      spec,
      tracked,
    });

    expect(plan.create).toMatchObject({
      title: "[check] opencode-qwencode-auth had update",
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
      title: "[check] opencode-qwencode-auth had update",
    });
    expect(plan.comments).toEqual([]);
    expect(plan.update).toBeNull();
    expect(plan.close).toEqual([]);
  });

  it("updates the canonical issue, comments on newer releases, and closes duplicates", () => {
    const previousLatest = {
      ...tracked,
      npmUrl: "https://www.npmjs.com/package/opencode-qwencode-auth/v/1.2.5",
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
          title: "[check] opencode-qwencode-auth had update",
        },
        {
          body: buildUpstreamPluginIssueBody({
            issueState: UPSTREAM_PLUGIN_ISSUE_STATE.UPDATE_AVAILABLE,
            latest: previousLatest,
            spec,
            tracked,
          }),
          number: 31,
          title: "[check] opencode-qwencode-auth had update",
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
        body: "Newer upstream npm release detected for opencode-qwencode-auth: 1.2.5 -> 1.3.0.",
        issueNumber: 23,
      },
    ]);
    expect(plan.close).toEqual([
      {
        commentBody: "Closing as duplicate of #23. The tracked reference is still behind npm 1.3.0.",
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
          title: "[check] opencode-qwencode-auth had update",
        },
      ],
      latest,
      spec,
      tracked,
    });

    expect(plan.create).toMatchObject({
      title: "[check] opencode-qwencode-auth had update",
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
          title: "[check] opencode-qwencode-auth had update",
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
