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

describe("contribution guidance", () => {
  const prTemplate = read(".github/pull_request_template.md");
  const contributing = read("CONTRIBUTING.md");

  it("places Before-and-after evidence after OpenCode Validation and before Quality Checklist", () => {
    const openCodeValidation = headingIndex(prTemplate, "OpenCode Validation");
    const evidence = headingIndex(prTemplate, "Before-and-after evidence");
    const quality = headingIndex(prTemplate, "Quality Checklist");
    expect(openCodeValidation).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(quality);
    expect(headingIndex(contributing, "Before-and-after evidence")).toBeLessThan(
      headingIndex(contributing, "Pull Request Checklist"),
    );
  });

  it("requires matching screenshots, four-surface reports, redaction, and justified Not applicable", () => {
    for (const document of [prTemplate, contributing]) {
      const evidence = readMarkdownSection(document, /^Before-and-after evidence$/);
      expect(evidence).toContain("matching before-and-after screenshots");
      expect(evidence).toContain("Web output");
      expect(evidence).toContain("TUI sidebar");
      expect(evidence).toContain("toast");
      expect(evidence).toContain("compact line below the message input");
      expect(evidence).toContain("prompt bar or command dialog when relevant");
      expect(evidence).toContain("unchanged or untested");
      expect(evidence).toMatch(
        /redact credentials, account identifiers, private paths, and other sensitive information/i,
      );
      expect(evidence).toContain("`Not applicable`");
      expect(evidence).toContain("explain briefly");
      expect(evidence).toContain("Formatter tests do not count as screenshot evidence");
    }

    expect(readMarkdownSection(contributing, /^Pull Request Checklist$/)).toContain(
      "Included matching before-and-after screenshots for visible changes and recorded the required surface checks, or explained why this does not apply.",
    );
  });

  it("uses canonical pnpm verify and keeps production-version and focused-change requirements", () => {
    expect(prTemplate).toContain("I ran `pnpm verify`");
    expect(prTemplate).not.toContain("I ran `pnpm run typecheck`");
    expect(prTemplate).not.toContain("I ran `pnpm run build`");
    expect(prTemplate).not.toContain("I ran `pnpm test`");
    expect(prTemplate).toContain("Current production released OpenCode version tested:");
    expect(prTemplate).toContain("This change is focused and avoids unrelated behavior changes");
    expect(contributing).toContain("`pnpm verify` passes.");
    expect(contributing).toContain("current production released OpenCode version");
  });
});
