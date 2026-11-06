import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { readMarkdownSection } from "./helpers/markdown-document.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function headingIndex(document: string, heading: string): number {
  const index = document.split("\n").findIndex((line) => line === `## ${heading}`);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

/** Every place v6 shows quota; PRs report each one the change can reach. */
const V6_SURFACES = [
  "TUI sidebar (open and collapsed)",
  "status line below the message input",
  "toasts",
  "`/quota` window tabs (Usage, Limits, Plugin, and the Settings tabs)",
  "Web and Desktop text commands",
  "CLI `show`/`status`",
  "export, telemetry, or agent tools",
];
/** v5 surfaces that v6 no longer has. */
const V5_SURFACES = [
  "prompt bar",
  "compact line",
  "/tokens_",
  "/pricing_refresh",
  "/quota_announcements",
  "command dialog",
  "wizard",
];

describe("contribution guidance", () => {
  const prTemplate = read(".github/pull_request_template.md");
  const contributing = read(".github/CONTRIBUTING.md");

  it("keeps the PR template to four short parts", () => {
    const headings = prTemplate.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## What users see change",
      "## Linked issue",
      "## Before and after screenshots",
      "## Checklist",
    ]);
    expect(prTemplate).toContain("`Nothing visible`");
    expect(prTemplate).toContain("`Fixes #...` (required if this changes a default or the UI)");
    expect(prTemplate).toContain("same config, model, theme and window size");
    expect(prTemplate).toContain(
      "(https://github.com/slkiser/opencode-quota/blob/main/.github/CONTRIBUTING.md#before-and-after-screenshots-required)",
    );
    expect(prTemplate.split("\n").length).toBeLessThan(25);
    expect(headingIndex(contributing, "Before-and-after screenshots (required)")).toBeLessThan(
      headingIndex(contributing, "PR checklist"),
    );
  });

  it("gives people a short text to paste into their AI", () => {
    const section = readMarkdownSection(contributing, /^If an AI writes your issue or PR$/);
    expect(section.trim().split("\n").length).toBeLessThan(10);
    for (const rule of [
      "what a user sees on screen",
      "title the problem, not the fix",
      "under 15 lines",
      "Name no function, file or commit unless asked",
      "issue form",
      "released OpenCode version",
      "needs a linked issue first",
    ]) {
      expect(section).toContain(rule);
    }
  });

  it("requires matching screenshots, surface reports, redaction, and justified Not applicable", () => {
    const contributingEvidence = readMarkdownSection(
      contributing,
      /^Before-and-after screenshots \(required\)$/,
    );
    expect(contributingEvidence).toContain("must include before-and-after screenshots");
    expect(contributingEvidence).toContain("same config, model, theme, and window size");
    for (const surface of V6_SURFACES) expect(contributingEvidence).toContain(surface);
    expect(contributingEvidence).toContain("Say which ones you didn't test");
    expect(contributingEvidence).toContain(
      "credentials, account identifiers, and private paths hidden",
    );
    expect(contributingEvidence).toContain("`Not applicable`");
    expect(contributingEvidence).toContain("Tests don't replace screenshots");

    expect(readMarkdownSection(contributing, /^PR checklist$/)).toContain(
      "Before-and-after screenshots and surface results, or `Not applicable`",
    );
  });

  it("names no v5 surface", () => {
    for (const surface of V5_SURFACES) {
      expect(prTemplate).not.toContain(surface);
      expect(contributing).not.toContain(surface);
    }
  });

  it("uses canonical pnpm verify and keeps the released-OpenCode requirement", () => {
    expect(prTemplate).toContain("I ran `pnpm verify`");
    expect(prTemplate).not.toContain("I ran `pnpm run typecheck`");
    expect(prTemplate).not.toContain("I ran `pnpm run build`");
    expect(prTemplate).not.toContain("I ran `pnpm test`");
    expect(contributing).toContain("`pnpm verify` passes");
    expect(contributing).toContain("Tested on the current released OpenCode");
    expect(contributing).toContain("smallest safe fix");
  });
});
