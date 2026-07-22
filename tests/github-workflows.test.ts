import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";
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

describe("GitHub workflows", () => {
  it("keeps provider-API-blocked issues exempt from stale automation", async () => {
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
          "exempt-issue-labels": "Blocked: not in provider API",
          "days-before-issue-stale": 23,
          "days-before-issue-close": 7,
          "days-before-pr-stale": -1,
          "days-before-pr-close": -1,
        }),
      }),
    );
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
