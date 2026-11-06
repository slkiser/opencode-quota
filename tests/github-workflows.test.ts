import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean | string;
  };
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
}

type IssueScriptCall = { method: string; labels?: string[]; name?: string };

// Runs one actions/github-script step of the issue workflow against a fake issue.
async function runIssueScript(
  jobId: string,
  issue: {
    title: string;
    body: string;
    labels?: string[];
    action?: string;
    comments?: string[];
  },
): Promise<IssueScriptCall[]> {
  const workflow = parse(
    await readFile(".github/workflows/thin-issue-check.yml", "utf8"),
  ) as Workflow;
  const script = workflow.jobs[jobId]?.steps?.[0]?.with?.script;
  if (typeof script !== "string") throw new Error(`no script in job ${jobId}`);

  const calls: IssueScriptCall[] = [];
  const github = {
    rest: {
      issues: {
        addLabels: async (params: { labels: string[] }) => {
          calls.push({ method: "addLabels", labels: params.labels });
        },
        createComment: async () => {
          calls.push({ method: "createComment" });
        },
        removeLabel: async (params: { name: string }) => {
          calls.push({ method: "removeLabel", name: params.name });
        },
        listComments: "listComments",
      },
    },
    paginate: async () => (issue.comments ?? []).map((body) => ({ body })),
  };
  const context = {
    repo: { owner: "slkiser", repo: "opencode-quota" },
    payload: {
      action: issue.action ?? "edited",
      issue: {
        number: 1,
        title: issue.title,
        body: issue.body,
        labels: (issue.labels ?? []).map((name) => ({ name })),
      },
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("github", "context", script)(github, context);
  return calls;
}

// GitHub renders each issue form answer as "### <label>", a blank line, then the answer.
function formBody(answers: Array<[label: string, answer: string]>): string {
  return answers.map(([label, answer]) => `### ${label}\n\n${answer}`).join("\n\n");
}

const LONG_SUMMARY = "The sidebar shows the weekly window twice after a restart.";

describe("GitHub workflows", () => {
  it("only lets stale automation close issues labeled needs info", async () => {
    const source = await readFile(".github/workflows/close-inactive-issues.yml", "utf8");
    const workflow = parse(source) as Workflow;
    const staleJob = workflow.jobs.stale;
    const staleStep = staleJob?.steps?.find(
      (step) => step.name === "Mark and close inactive issues",
    );

    expect(staleStep).toEqual(
      expect.objectContaining({
        uses: "actions/stale@v10",
        with: expect.objectContaining({
          "only-issue-labels": "needs info",
          "days-before-issue-stale": 14,
          "days-before-issue-close": 7,
          "days-before-pr-stale": -1,
          "days-before-pr-close": -1,
        }),
      }),
    );
    expect(staleStep?.with).not.toHaveProperty("exempt-issue-labels");
  });

  it("runs the thin issue check with only issues write permission", async () => {
    const source = await readFile(".github/workflows/thin-issue-check.yml", "utf8");
    const workflow = parse(source) as Workflow;

    expect(workflow.jobs.check?.permissions).toEqual({ issues: "write" });
  });

  it("adds the v4 label from the issue form answer, and never removes labels", async () => {
    const workflow = parse(
      await readFile(".github/workflows/thin-issue-check.yml", "utf8"),
    ) as Workflow;
    expect(workflow.jobs["version-labels"]?.permissions).toEqual({ issues: "write" });

    const title = "Sidebar shows a window twice";
    const v4Body = formBody([
      ["Which OpenCode do you use?", "OpenCode 1"],
      ["What went wrong?", LONG_SUMMARY],
    ]);
    await expect(runIssueScript("version-labels", { title, body: v4Body })).resolves.toEqual([
      { method: "addLabels", labels: ["v4"] },
    ]);
    await expect(
      runIssueScript("version-labels", { title, body: v4Body.replace(/\n/gu, "\r\n") }),
    ).resolves.toEqual([{ method: "addLabels", labels: ["v4"] }]);
    await expect(
      runIssueScript("version-labels", {
        title,
        body: formBody([
          ["Which OpenCode do you use?", "OpenCode 1"],
          ["What's the problem?", LONG_SUMMARY],
        ]),
      }),
    ).resolves.toEqual([{ method: "addLabels", labels: ["v4"] }]);

    for (const body of [
      formBody([["Which OpenCode do you use?", "OpenCode 2"]]),
      formBody([["What went wrong?", "OpenCode 1"]]),
      "",
    ]) {
      await expect(runIssueScript("version-labels", { title, body })).resolves.toEqual([]);
    }
    // Already labeled (or labeled by hand with an answer that no longer matches): no calls.
    await expect(
      runIssueScript("version-labels", { title, body: v4Body, labels: ["v4"] }),
    ).resolves.toEqual([]);
    await expect(
      runIssueScript("version-labels", {
        title,
        body: formBody([["Which OpenCode do you use?", "OpenCode 2"]]),
        labels: ["v4", "v6"],
      }),
    ).resolves.toEqual([]);
  });

  it("does not count the version dropdown answers as typed text in the thin issue check", async () => {
    const thinBody = formBody([
      ["Which OpenCode do you use?", "OpenCode 1"],
      ["What went wrong?", "broken"],
    ]);
    await expect(
      runIssueScript("check", { title: "Sidebar shows a window twice", body: thinBody }),
    ).resolves.toEqual([
      { method: "addLabels", labels: ["needs info"] },
      { method: "createComment" },
    ]);

    const fullBody = formBody([
      ["Which OpenCode do you use?", "OpenCode 2"],
      ["What went wrong?", LONG_SUMMARY],
    ]);
    await expect(
      runIssueScript("check", { title: "Sidebar shows a window twice", body: fullBody }),
    ).resolves.toEqual([]);
  });

  it("counts a typed dropdown answer outside its own dropdown in the thin issue check", async () => {
    // 45 typed characters without spaces; dropping the typed "OpenCode 1" leaves 36 (< 40).
    const body = formBody([
      ["Which OpenCode do you use?", "OpenCode 2"],
      ["OpenCode version", "2.0.20"],
      ["What's the problem?", "Quota retries stop."],
      ["What would you like to happen?", "Wait for reset."],
      ["Other ideas you thought about (optional)", "OpenCode 1"],
    ]);
    await expect(
      runIssueScript("check", { title: "Retries stop at the limit", body }),
    ).resolves.toEqual([]);

    // The dropdown's own answer still does not count.
    await expect(
      runIssueScript("check", {
        title: "Retries stop at the limit",
        body: body.replace(
          "Other ideas you thought about (optional)\n\nOpenCode 1",
          "Other ideas you thought about (optional)\n\n_No response_",
        ),
      }),
    ).resolves.toEqual([
      { method: "addLabels", labels: ["needs info"] },
      { method: "createComment" },
    ]);
  });

  it("asks what the reporter sees first, then which OpenCode", async () => {
    type Field = {
      type: string;
      id?: string;
      attributes: { label?: string; options?: unknown[] };
      validations?: { required?: boolean };
    };
    const readForm = async (file: string) =>
      parse(await readFile(`.github/ISSUE_TEMPLATE/${file}`, "utf8")) as { body: Field[] };
    const bug = await readForm("bug_report.yml");
    const feature = await readForm("feature_request.yml");
    const provider = await readForm("provider_request.yml");

    for (const form of [bug, feature, provider]) {
      expect(form.body[0]?.type).toBe("markdown");
      expect(form.body[0]?.attributes).toMatchObject({
        value: expect.stringContaining("Title: the problem you see, not the fix."),
      });
    }
    for (const form of [bug, feature]) {
      expect(form.body[1]).toMatchObject({
        type: "input",
        id: "what_you_see",
        attributes: { label: "In one sentence, what do you see?" },
        validations: { required: true },
      });
    }
    expect(provider.body[1]).toMatchObject({
      type: "input",
      id: "what_should_show",
      attributes: { label: "In one sentence, what should the plugin show for this provider?" },
      validations: { required: true },
    });

    expect(bug.body[2]).toMatchObject({
      type: "dropdown",
      id: "opencode_line",
      attributes: {
        label: "Which OpenCode do you use?",
        options: ["OpenCode 2", "OpenCode 1"],
      },
      validations: { required: true },
    });
    expect(feature.body[2]).toEqual(bug.body[2]);
  });

  it("keeps issue forms without title prefills and with their labels", async () => {
    const expectedLabels: Record<string, string[]> = {
      "bug_report.yml": ["bug"],
      "feature_request.yml": ["feature"],
      "provider_request.yml": ["provider"],
    };
    for (const [file, labels] of Object.entries(expectedLabels)) {
      const form = parse(await readFile(`.github/ISSUE_TEMPLATE/${file}`, "utf8")) as {
        title?: string;
        labels?: string[];
      };
      expect(form.title, file).toBeUndefined();
      expect(form.labels, file).toEqual(labels);
    }
  });

  it("skips bot authors in the thin issue check", async () => {
    const workflow = parse(
      await readFile(".github/workflows/thin-issue-check.yml", "utf8"),
    ) as Workflow & { jobs: Record<string, { if?: string }> };
    expect(workflow.jobs.check?.if).toContain("github.event.issue.user.type != 'Bot'");
    expect(workflow.jobs.check?.if).toContain("OWNER");
  });

  it("asks for a new issue with a form, once, when a new issue has no form label", async () => {
    const title = "Sidebar shows a window twice";
    const body = "The sidebar shows the weekly window twice after a restart.";
    await expect(runIssueScript("check", { title, body, action: "opened" })).resolves.toEqual([
      { method: "addLabels", labels: ["needs info"] },
      { method: "createComment" },
    ]);

    // Already asked: no second comment.
    await expect(
      runIssueScript("check", {
        title,
        body,
        action: "opened",
        labels: ["needs info"],
        comments: ["<!-- no-form-issue-check -->\nPlease open a new issue"],
      }),
    ).resolves.toEqual([]);

    // A form label means the issue came from a form: only the thin check applies.
    for (const label of ["bug", "feature", "provider"]) {
      await expect(
        runIssueScript("check", { title, body, action: "opened", labels: [label] }),
      ).resolves.toEqual([]);
    }
    // Edits never run the form-less check.
    await expect(runIssueScript("check", { title, body, action: "edited" })).resolves.toEqual([]);
  });

  it("keeps needs info on an issue flagged as not from a form, but still removes its own thin label", async () => {
    const title = "Sidebar shows a window twice";
    const body = "The sidebar shows the weekly window twice after a restart.";
    await expect(
      runIssueScript("check", {
        title,
        body,
        labels: ["needs info"],
        comments: ["<!-- thin-issue-check -->\nshort", "<!-- no-form-issue-check -->\nask"],
      }),
    ).resolves.toEqual([]);
    await expect(
      runIssueScript("check", {
        title,
        body,
        labels: ["bug", "needs info"],
        comments: ["<!-- thin-issue-check -->\nshort"],
      }),
    ).resolves.toEqual([{ method: "removeLabel", name: "needs info" }]);
  });

  it("creates upstream update issues with the upstream update label", async () => {
    // Runs the script with a fake fetch: npm reports a far newer version for every plugin,
    // GitHub has no issues yet, and every request it sends is printed.
    const { UPSTREAM_PLUGIN_SPECS } =
      await import("../.github/scripts/lib/upstream-plugin-specs.mjs");
    const specs = UPSTREAM_PLUGIN_SPECS.map((spec: Record<string, unknown>) => ({
      packageName: spec.packageName,
      distTag: spec.distTag,
      repo: spec.repo,
    }));
    const preload = `
      const specs = ${JSON.stringify(specs)};
      globalThis.fetch = async (url, init = {}) => {
        const json = (data) => new Response(JSON.stringify(data), { status: 200 });
        const href = String(url);
        if (href.startsWith("https://registry.npmjs.org/")) {
          const spec = specs.find((s) => href === "https://registry.npmjs.org/" + encodeURIComponent(s.packageName));
          const version = "999.0.0";
          return json({
            "dist-tags": { [spec.distTag]: version },
            versions: { [version]: { dist: { tarball: "https://example.test/x.tgz" }, repository: "github:" + spec.repo } },
            time: { [version]: "2026-01-01T00:00:00.000Z" },
          });
        }
        if ((init.method ?? "GET") === "GET") return json([]);
        console.log("REQUEST " + JSON.stringify({ method: init.method, url: href, body: JSON.parse(init.body) }));
        return json({});
      };
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        ".github/scripts/check-upstream-plugin-updates.mjs",
        "--write-issues",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_REPOSITORY: "slkiser/opencode-quota", GITHUB_TOKEN: "test" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const created = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("REQUEST "))
      .map((line) => JSON.parse(line.slice("REQUEST ".length)))
      .filter((request) => request.method === "POST" && request.url.endsWith("/issues"));
    expect(created).toHaveLength(specs.length);
    for (const request of created) {
      expect(request.body.labels).toEqual(["upstream update"]);
    }
  });

  it("asks for a linked issue on a PR that changes a default or the UI, once", async () => {
    const workflow = parse(
      await readFile(".github/workflows/pr-intake-check.yml", "utf8"),
    ) as Workflow & {
      on: { pull_request_target: { types: string[] } };
      jobs: Record<string, { if?: string }>;
    };
    expect(workflow.on.pull_request_target.types).toEqual(["opened", "edited", "synchronize"]);
    expect(workflow.jobs.check?.permissions).toEqual({
      "pull-requests": "write",
      issues: "write",
      contents: "read",
    });
    expect(workflow.jobs.check?.if).toContain("github.event.pull_request.user.type != 'Bot'");
    expect(workflow.jobs.check?.if).toContain("OWNER");
    const steps = workflow.jobs.check?.steps ?? [];
    // Never checks out or runs PR code.
    expect(steps.map((step) => step.uses)).toEqual(["actions/github-script@v9"]);
    expect(steps.every((step) => step.run === undefined)).toBe(true);

    const script = steps[0]?.with?.script;
    if (typeof script !== "string") throw new Error("no script in pr-intake-check");
    const bot = "github-actions[bot]";
    type LabelEvent = { event: "labeled" | "unlabeled"; by: string };
    const run = async (pr: {
      body: string;
      files: string[];
      labels?: string[];
      comments?: { body: string; by: string }[];
      labelEvents?: LabelEvent[];
    }) => {
      const calls: IssueScriptCall[] = [];
      const github = {
        rest: {
          pulls: {
            listFiles: "listFiles",
            get: async () => ({
              data: {
                number: 1,
                body: pr.body,
                labels: (pr.labels ?? []).map((name) => ({ name })),
              },
            }),
          },
          issues: {
            listComments: "listComments",
            listEvents: "listEvents",
            addLabels: async (params: { labels: string[] }) => {
              calls.push({ method: "addLabels", labels: params.labels });
            },
            createComment: async () => {
              calls.push({ method: "createComment" });
            },
            removeLabel: async (params: { name: string }) => {
              calls.push({ method: "removeLabel", name: params.name });
            },
          },
        },
        paginate: async (method: string) => {
          if (method === "listFiles") return pr.files.map((filename) => ({ filename }));
          if (method === "listEvents") {
            return (pr.labelEvents ?? []).map((e) => ({
              event: e.event,
              label: { name: "needs info" },
              actor: { login: e.by },
            }));
          }
          return (pr.comments ?? []).map((c) => ({ body: c.body, user: { login: c.by } }));
        },
      };
      // The queued payload is stale on purpose: the script must read the PR again.
      const context = {
        repo: { owner: "slkiser", repo: "opencode-quota" },
        payload: { pull_request: { number: 1, body: "stale", labels: [] } },
      };
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction("github", "context", script)(github, context);
      return calls;
    };
    const asked = [{ method: "addLabels", labels: ["needs info"] }, { method: "createComment" }];
    const ourComment = { body: "<!-- pr-intake-check -->\nask", by: bot };
    const weLabeled: LabelEvent[] = [{ event: "labeled", by: bot }];

    for (const file of [
      "src/tui/sidebar.tsx",
      "src/gui/panel.tsx",
      "src/view/format.ts",
      "src/settings/schema.ts",
      "src/settings/shared.ts",
    ]) {
      await expect(run({ body: "Makes it nicer.", files: [file] })).resolves.toEqual(asked);
      await expect(run({ body: "Fixes #12", files: [file] })).resolves.toEqual([]);
    }
    // The untouched template text is not an issue link.
    await expect(
      run({ body: "## Linked issue\n\n`Fixes #...` (required)", files: ["src/tui/sidebar.tsx"] }),
    ).resolves.toEqual(asked);
    for (const body of [
      "closes #3",
      "RESOLVES: #3",
      "Fix #3",
      "Close #3",
      "See #3",
      "#3",
      "Refs slkiser/opencode-quota#3",
      "See https://github.com/slkiser/opencode-quota/issues/3",
    ]) {
      await expect(run({ body, files: ["src/gui/panel.tsx"] })).resolves.toEqual([]);
    }
    // Not issue links: an HTML entity and a URL fragment.
    for (const body of ["a &#123; b", "https://example.com/page#3"]) {
      await expect(run({ body, files: ["src/gui/panel.tsx"] })).resolves.toEqual(asked);
    }
    // Other files never need an issue.
    await expect(run({ body: "", files: ["src/providers/mimo.ts", "README.md"] })).resolves.toEqual(
      [],
    );
    // Already asked and labeled: nothing more.
    await expect(
      run({
        body: "",
        files: ["src/tui/sidebar.tsx"],
        labels: ["needs info"],
        comments: [ourComment],
        labelEvents: weLabeled,
      }),
    ).resolves.toEqual([]);
    // Link added later: remove the label this workflow added.
    await expect(
      run({
        body: "Fixes #12",
        files: ["src/tui/sidebar.tsx"],
        labels: ["needs info"],
        comments: [ourComment],
        labelEvents: weLabeled,
      }),
    ).resolves.toEqual([{ method: "removeLabel", name: "needs info" }]);
    // Link removed again: put the label back, but do not comment twice.
    await expect(
      run({
        body: "",
        files: ["src/tui/sidebar.tsx"],
        comments: [ourComment],
        labelEvents: [...weLabeled, { event: "unlabeled", by: bot }],
      }),
    ).resolves.toEqual([{ method: "addLabels", labels: ["needs info"] }]);
    // A maintainer's label stays, even after this workflow commented.
    await expect(
      run({
        body: "Fixes #12",
        files: ["src/tui/sidebar.tsx"],
        labels: ["needs info"],
        comments: [ourComment],
        labelEvents: [{ event: "labeled", by: "slkiser" }],
      }),
    ).resolves.toEqual([]);
    // A label a maintainer took off is not added back.
    await expect(
      run({
        body: "",
        files: ["src/tui/sidebar.tsx"],
        comments: [ourComment],
        labelEvents: [...weLabeled, { event: "unlabeled", by: "slkiser" }],
      }),
    ).resolves.toEqual([]);
    // A marker comment posted by someone else does not count as asked.
    await expect(
      run({
        body: "",
        files: ["src/tui/sidebar.tsx"],
        comments: [{ body: "<!-- pr-intake-check -->", by: "someone" }],
      }),
    ).resolves.toEqual(asked);
  });

  it("keeps upstream issue reconciliation on Node 22 with minimal permissions", async () => {
    const source = await readFile(".github/workflows/upstream-plugin-update-check.yml", "utf8");
    const workflow = parse(source) as Workflow;
    const checkJob = workflow.jobs.check;
    const setupNode = checkJob?.steps?.find((step) => step.name === "Setup Node.js");
    const reconcile = checkJob?.steps?.find(
      (step) => step.name === "Reconcile upstream plugin issues",
    );

    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(checkJob?.permissions).toEqual({
      contents: "read",
      issues: "write",
    });
    expect(setupNode?.with?.["node-version"]).toBe(22);
    expect(reconcile?.run).toBe(
      "node .github/scripts/check-upstream-plugin-updates.mjs --write-issues",
    );

    const workflowFiles = (await readdir(".github/workflows")).filter((file) =>
      /\.ya?ml$/u.test(file),
    );
    const writeIssueWorkflows: string[] = [];
    for (const file of workflowFiles) {
      const workflowSource = await readFile(`.github/workflows/${file}`, "utf8");
      if (workflowSource.includes("--write-issues")) {
        writeIssueWorkflows.push(file);
      }
    }
    expect(writeIssueWorkflows).toEqual(["upstream-plugin-update-check.yml"]);
  });

  it("cancels a stale pull request CI run but never a push to main", async () => {
    const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;
    // A pull request run shares its number's group; every push to main gets a group of its own
    // (its commit), so no push to main cancels or replaces another.
    const group =
      "ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}";
    expect(workflow.concurrency).toEqual({
      group,
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
  });
});
