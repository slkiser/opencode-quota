import { getTrackedUpstreamPluginIdentityDifferences } from "./upstream-plugin-identity.mjs";

const DEFAULT_PATH_LIMIT_PER_PLUGIN = 12;
const DEFAULT_DIFF_LIMIT_PER_PLUGIN = 4;
const DEFAULT_DIFF_LINE_LIMIT = 80;

export function groupReferenceChangesByPlugin(paths) {
  const grouped = new Map();

  for (const relativePath of [...paths].sort((left, right) => left.localeCompare(right))) {
    const parts = relativePath.split("/");
    if (parts.length < 4) continue;
    if (parts[0] !== "references" || parts[1] !== "upstream-plugins") continue;

    const pluginId = parts[2];
    if (!grouped.has(pluginId)) grouped.set(pluginId, []);
    grouped.get(pluginId).push(relativePath);
  }

  return grouped;
}

export function buildChangedPluginSummaries(previousLock, currentLock) {
  const summaries = [];

  for (const pluginId of Object.keys(currentLock.plugins).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const previous = previousLock?.plugins?.[pluginId];
    const current = currentLock.plugins[pluginId];
    const changedFields = getTrackedUpstreamPluginIdentityDifferences(previous, current);

    if (changedFields.length === 0) continue;

    summaries.push({
      pluginId,
      previousVersion: previous?.version ?? null,
      currentVersion: current.version,
      changeKind: !previous ? "added" : changedFields.includes("version") ? "version" : "metadata",
      changedFields,
    });
  }

  return summaries;
}

export function includeChangedReferencePluginSummaries(
  previousLock,
  currentLock,
  changedFilesByPlugin,
  changedPlugins,
) {
  const summariesByPluginId = new Map(changedPlugins.map((summary) => [summary.pluginId, summary]));

  for (const pluginId of [...changedFilesByPlugin.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (summariesByPluginId.has(pluginId)) continue;

    const previous = previousLock?.plugins?.[pluginId];
    const current = currentLock?.plugins?.[pluginId];
    const version = current?.version ?? previous?.version;
    if (!version) continue;

    summariesByPluginId.set(pluginId, {
      pluginId,
      previousVersion: previous?.version ?? null,
      currentVersion: version,
      changeKind: previous ? "metadata" : "added",
      changedFields: ["reference contents"],
    });
  }

  return [...summariesByPluginId.values()].sort((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
}

export function shouldPrepareUpstreamPluginReview(identityChangedPlugins, changedReferenceFiles) {
  return identityChangedPlugins.length > 0 || changedReferenceFiles.length > 0;
}

export function formatChangedPluginSummary(summary) {
  if (summary.changeKind === "added") {
    return `${summary.pluginId}: newly tracked at ${summary.currentVersion}`;
  }

  if (summary.changeKind === "metadata") {
    return `${summary.pluginId}: metadata changed at ${summary.currentVersion} (${summary.changedFields.join(", ")})`;
  }

  return `${summary.pluginId}: ${summary.previousVersion} -> ${summary.currentVersion}`;
}

function limitList(items, limit) {
  if (items.length <= limit) {
    return { omittedCount: 0, visibleItems: items };
  }

  return {
    omittedCount: items.length - limit,
    visibleItems: items.slice(0, limit),
  };
}

export function trimDiffPreview(diffText, maxLines = DEFAULT_DIFF_LINE_LIMIT) {
  const normalized = diffText.trim();
  if (!normalized) return { text: "(no diff preview available)", truncated: false };

  const lines = normalized.split("\n");
  if (lines.length <= maxLines) {
    return { text: normalized, truncated: false };
  }

  return {
    text: `${lines.slice(0, maxLines).join("\n")}\n... diff truncated ...`,
    truncated: true,
  };
}

function formatCheckOutcome(result) {
  const commandLabel = `\`${result.command}\``;

  if (result.ok) {
    return `- ${commandLabel}: passed`;
  }

  return `- ${commandLabel}: failed (exit ${result.exitCode ?? 1})`;
}

export function buildUpstreamPluginReviewPrompt({
  changedFilesByPlugin,
  changedPlugins,
  diffPreviewByPath,
  testResult,
  typecheckResult,
}) {
  const lines = [
    "Please check whether these upstream plugin updates conflict with the current local opencode-quota plugin.",
    "",
    "Updated plugins:",
  ];

  for (const summary of changedPlugins) {
    lines.push(`- ${formatChangedPluginSummary(summary)}`);
  }

  lines.push("", "Changed files:");

  for (const summary of changedPlugins) {
    const pluginPaths = changedFilesByPlugin.get(summary.pluginId) ?? [];
    const { omittedCount, visibleItems } = limitList(pluginPaths, DEFAULT_PATH_LIMIT_PER_PLUGIN);

    lines.push(`- ${summary.pluginId}:`);
    if (visibleItems.length === 0) {
      lines.push("  - No path-level diff captured; inspect the plugin directory locally.");
      continue;
    }

    for (const filePath of visibleItems) {
      lines.push(`  - ${filePath}`);
    }

    if (omittedCount > 0) {
      lines.push(`  - ... ${omittedCount} more changed files omitted from this prompt`);
    }
  }

  lines.push("", "Diff previews:");

  for (const summary of changedPlugins) {
    const pluginPaths = changedFilesByPlugin.get(summary.pluginId) ?? [];
    const { omittedCount, visibleItems } = limitList(pluginPaths, DEFAULT_DIFF_LIMIT_PER_PLUGIN);

    lines.push(`- ${summary.pluginId}:`);
    if (visibleItems.length === 0) {
      lines.push("  - No diff preview captured.");
      continue;
    }

    for (const filePath of visibleItems) {
      lines.push(`  - ${filePath}`);
      lines.push("```diff");
      lines.push(diffPreviewByPath.get(filePath) ?? "(no diff preview available)");
      lines.push("```");
    }

    if (omittedCount > 0) {
      lines.push(`  - ... ${omittedCount} more diff previews omitted`);
    }
  }

  lines.push("", "Checks:");
  lines.push(formatCheckOutcome(testResult));
  lines.push(formatCheckOutcome(typecheckResult));

  if (!testResult.ok && testResult.output) {
    lines.push("", `${testResult.command} output:`);
    lines.push("```text");
    lines.push(testResult.output.trim());
    lines.push("```");
  }

  if (!typecheckResult.ok && typecheckResult.output) {
    lines.push("", `${typecheckResult.command} output:`);
    lines.push("```text");
    lines.push(typecheckResult.output.trim());
    lines.push("```");
  }

  lines.push(
    "",
    "If you find no conflicts, I plan to close the GitHub issue manually. If you find conflicts, tell me exactly what changed in opencode-quota and what should be fixed before I push to main and cut a release.",
  );

  return `${lines.join("\n").trim()}\n`;
}
