import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildOpenCodeConfigCandidates,
  readOpenCodeConfigCandidate,
  selectFirstExistingOpenCodeConfigCandidate,
} from "../src/lib/opencode-config-read.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-config-read-"));
  tempDirs.push(dir);
  return dir;
}

describe("read-only OpenCode config mechanics", () => {
  it("builds candidates in caller-supplied directory and format order", () => {
    expect(
      buildOpenCodeConfigCandidates({
        directories: ["/global", "/workspace"],
        formatOrder: ["jsonc", "json"],
      }),
    ).toEqual([
      { path: "/global/opencode.jsonc", format: "jsonc" },
      { path: "/global/opencode.json", format: "json" },
      { path: "/workspace/opencode.jsonc", format: "jsonc" },
      { path: "/workspace/opencode.json", format: "json" },
    ]);
  });

  it("selects only the first existing candidate", () => {
    const dir = tempDir();
    const candidates = buildOpenCodeConfigCandidates({
      directories: [dir],
      formatOrder: ["jsonc", "json"],
    });
    writeFileSync(candidates[1]!.path, "{}", "utf8");
    expect(selectFirstExistingOpenCodeConfigCandidate(candidates)).toEqual(candidates[1]);
    writeFileSync(candidates[0]!.path, "{}", "utf8");
    expect(selectFirstExistingOpenCodeConfigCandidate(candidates)).toEqual(candidates[0]);
  });

  it("distinguishes missing, invalid, and parsed JSONC without exposing parser details", async () => {
    const dir = tempDir();
    const [candidate] = buildOpenCodeConfigCandidates({
      directories: [dir],
      formatOrder: ["jsonc"],
    });

    await expect(readOpenCodeConfigCandidate(candidate!)).resolves.toEqual({
      state: "missing",
      candidate,
    });
    writeFileSync(candidate!.path, "{ nope", "utf8");
    await expect(readOpenCodeConfigCandidate(candidate!)).resolves.toEqual({
      state: "invalid",
      candidate,
    });
    writeFileSync(candidate!.path, '{ // comment\n "provider": {},\n}', "utf8");
    await expect(readOpenCodeConfigCandidate(candidate!)).resolves.toMatchObject({
      state: "parsed",
      candidate,
      value: { provider: {} },
    });
  });
});
