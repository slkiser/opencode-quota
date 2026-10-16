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
  "`/quota` window tabs (Usage, Limits, Plugin, Settings)",
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

  it("places Before-and-after evidence after OpenCode Validation and before Quality Checklist", () => {
    const openCodeValidation = headingIndex(prTemplate, "OpenCode Validation");
    const evidence = headingIndex(prTemplate, "Before-and-after evidence");
    const quality = headingIndex(prTemplate, "Quality Checklist");
    expect(openCodeValidation).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(quality);
    expect(headingIndex(contributing, "Before-and-after screenshots (required)")).toBeLessThan(
      headingIndex(contributing, "PR checklist"),
    );
  });

  it("requires matching screenshots, four-surface reports, redaction, and justified Not applicable", () => {
    const templateEvidence = readMarkdownSection(prTemplate, /^Before-and-after evidence$/);
    expect(templateEvidence).toContain("matching before-and-after screenshots");
    for (const surface of V6_SURFACES) expect(templateEvidence).toContain(surface);
    expect(templateEvidence).toContain("unchanged or untested");
    expect(templateEvidence).toMatch(
      /redact credentials, account identifiers, private paths, and other sensitive information/i,
    );
    expect(templateEvidence).toContain("`Not applicable`");
    expect(templateEvidence).toContain("explain briefly");
    expect(templateEvidence).toContain("Formatter tests do not count as screenshot evidence");

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

  it("uses canonical pnpm verify and keeps production-version and focused-change requirements", () => {
    expect(prTemplate).toContain("I ran `pnpm verify`");
    expect(prTemplate).not.toContain("I ran `pnpm run typecheck`");
    expect(prTemplate).not.toContain("I ran `pnpm run build`");
    expect(prTemplate).not.toContain("I ran `pnpm test`");
    expect(prTemplate).toContain("Current production released OpenCode version tested:");
    expect(prTemplate).toContain("This change is focused and avoids unrelated behavior changes");
    expect(contributing).toContain("`pnpm verify` passes");
    expect(contributing).toContain("Tested on the current released OpenCode");
    expect(contributing).toContain("smallest safe fix");
  });
});
