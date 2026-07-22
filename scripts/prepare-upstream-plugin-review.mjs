import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { readCommittedUpstreamPluginLock } from "./lib/upstream-plugin-lock.mjs";
import { repoRoot, upstreamPluginReferenceRoot } from "./lib/upstream-plugin-paths.mjs";
import {
  buildChangedPluginSummaries,
  buildUpstreamPluginReviewPrompt,
  formatChangedPluginSummary,
  groupReferenceChangesByPlugin,
  includeChangedReferencePluginSummaries,
  shouldPrepareUpstreamPluginReview,
  trimDiffPreview,
} from "./lib/upstream-plugin-review.mjs";
import { syncUpstreamPluginReferences } from "./lib/upstream-plugin-sync.mjs";
import { getUpstreamPluginIssueTitle } from "./lib/upstream-plugin-specs.mjs";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_CHARS = 8_000;

function getReferenceRootRelativePath() {
  return path.relative(repoRoot, upstreamPluginReferenceRoot).replaceAll(path.sep, "/");
}

function normalizeExecOutput(errorOrResult) {
  const stdout =
    "stdout" in errorOrResult && typeof errorOrResult.stdout === "string"
      ? errorOrResult.stdout
      : "";
  const stderr =
    "stderr" in errorOrResult && typeof errorOrResult.stderr === "string"
      ? errorOrResult.stderr
      : "";
  const combined = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.trim();

  return combined.length > MAX_COMMAND_OUTPUT_CHARS
    ? `${combined.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n... output truncated ...`
    : combined;
}

async function runPackageManagerCommand(args) {
  const command = `pnpm ${args.join(" ")}`;

  try {
    const result = await execFileAsync("pnpm", args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      command,
      exitCode: 0,
      ok: true,
      output: normalizeExecOutput(result),
    };
  } catch (error) {
    return {
      command,
      exitCode:
        error && typeof error === "object" && "code" in error && typeof error.code === "number"
          ? error.code
          : 1,
      ok: false,
      output: normalizeExecOutput(error),
    };
  }
}

function parseStatusLine(line) {
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const normalizedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;

  return {
    path: normalizedPath,
    status,
  };
}

async function listChangedReferenceFiles() {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", getReferenceRootRelativePath()],
    {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parseStatusLine)
    .filter(({ path: filePath }) => filePath.startsWith(`${getReferenceRootRelativePath()}/`));
}

async function captureGitDiff(args) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return error.stdout;
    }
    return "";
  }
}

async function buildDiffPreviewForFile(change) {
  const filePath = change.path;
  const status = change.status.trim();

  if (status === "??") {
    return captureGitDiff([
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--unified=3",
      "--",
      "/dev/null",
      filePath,
    ]);
  }

  return captureGitDiff(["diff", "--no-ext-diff", "--unified=3", "--", filePath]);
}

function printChangedPluginSummary(changedPlugins) {
  console.log("Updated plugins to review:");
  for (const summary of changedPlugins) {
    console.log(`- ${formatChangedPluginSummary(summary)}`);
    console.log(`  Issue: ${getUpstreamPluginIssueTitle(summary.pluginId)}`);
  }
}

async function main() {
  const previousLock = await readCommittedUpstreamPluginLock();
  const { lock } = await syncUpstreamPluginReferences();
  const changedReferenceFiles = await listChangedReferenceFiles();
  const changedFilesByPlugin = groupReferenceChangesByPlugin(
    changedReferenceFiles.map((entry) => entry.path),
  );
  const identityChangedPlugins = buildChangedPluginSummaries(previousLock, lock);

  if (!shouldPrepareUpstreamPluginReview(identityChangedPlugins, changedReferenceFiles)) {
    console.log(
      "No upstream plugin identity or reference changes detected. Nothing new needs review.",
    );
    return;
  }

  const changedPlugins = includeChangedReferencePluginSummaries(
    previousLock,
    lock,
    changedFilesByPlugin,
    identityChangedPlugins,
  );
  const diffPreviewByPath = new Map();

  for (const change of changedReferenceFiles) {
    const diffText = await buildDiffPreviewForFile(change);
    diffPreviewByPath.set(change.path, trimDiffPreview(diffText).text);
  }

  const testResult = await runPackageManagerCommand(["test"]);
  const typecheckResult = await runPackageManagerCommand(["run", "typecheck"]);

  printChangedPluginSummary(changedPlugins);
  console.log("");
  console.log("Paste this prompt to another agent:");
  console.log("");
  console.log(
    buildUpstreamPluginReviewPrompt({
      changedFilesByPlugin,
      changedPlugins,
      diffPreviewByPath,
      testResult,
      typecheckResult,
    }),
  );

  if (!testResult.ok || !typecheckResult.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
