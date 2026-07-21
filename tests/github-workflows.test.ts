import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
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
});
