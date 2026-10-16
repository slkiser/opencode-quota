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
    "cancel-in-progress"?: boolean;
  };
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
}

type IssueScriptCall = { method: string; labels?: string[] };

// Runs one actions/github-script step of the issue workflow against a fake issue.
async function runIssueScript(
  jobId: string,
  issue: { title: string; body: string; labels?: string[] },
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
      },
    },
  };
  const context = {
    repo: { owner: "slkiser", repo: "opencode-quota" },
    payload: {
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

  it("adds v4 and v6 labels from issue form answers, and never removes labels", async () => {
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
          ["Does this change what you see on screen?", "Yes"],
          ["What's the problem?", LONG_SUMMARY],
        ]),
      }),
    ).resolves.toEqual([{ method: "addLabels", labels: ["v6"] }]);

    for (const body of [
      formBody([["Which OpenCode do you use?", "OpenCode 2"]]),
      formBody([["Does this change what you see on screen?", "No"]]),
      formBody([["Does this change what you see on screen?", "Not sure"]]),
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
      ["Does this change what you see on screen?", "No"],
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
    // 43 typed characters without spaces; dropping the typed "Not sure" leaves 36 (< 40).
    const body = formBody([
      ["Does this change what you see on screen?", "Not sure"],
      ["OpenCode version", "2.0.20"],
      ["What's the problem?", "Quota retries stop."],
      ["What would you like to happen?", "Wait for reset."],
      ["Other ideas you thought about (optional)", "Not sure"],
    ]);
    await expect(
      runIssueScript("check", { title: "Retries stop at the limit", body }),
    ).resolves.toEqual([]);

    // The dropdown's own "Not sure" still does not count.
    await expect(
      runIssueScript("check", {
        title: "Retries stop at the limit",
        body: body.replace(
          "Other ideas you thought about (optional)\n\nNot sure",
          "Other ideas you thought about (optional)\n\n_No response_",
        ),
      }),
    ).resolves.toEqual([
      { method: "addLabels", labels: ["needs info"] },
      { method: "createComment" },
    ]);
  });

  it("asks which OpenCode and whether the display changes right after the intro", async () => {
    const bug = parse(await readFile(".github/ISSUE_TEMPLATE/bug_report.yml", "utf8")) as {
      body: Array<{ id?: string; attributes: { label?: string; options?: unknown[] } }>;
    };
    const feature = parse(
      await readFile(".github/ISSUE_TEMPLATE/feature_request.yml", "utf8"),
    ) as typeof bug;

    expect(bug.body[1]).toMatchObject({
      type: "dropdown",
      id: "opencode_line",
      attributes: {
        label: "Which OpenCode do you use?",
        options: ["OpenCode 2", "OpenCode 1"],
      },
      validations: { required: true },
    });
    expect(feature.body[1]).toMatchObject({
      type: "dropdown",
      id: "display_change",
      attributes: {
        label: "Does this change what you see on screen?",
        options: ["No", "Yes", "Not sure"],
      },
      validations: { required: true },
    });
  });

  it("keeps issue forms without title prefills and with their labels", async () => {
    const expectedLabels: Record<string, string[]> = {
      "bug_report.yml": ["bug"],
      "feature_request.yml": ["enhancement"],
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
    expect(reconcile?.run).toBe("node scripts/check-upstream-plugin-updates.mjs --write-issues");

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
});
