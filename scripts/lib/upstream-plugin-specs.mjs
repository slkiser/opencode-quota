export const UPSTREAM_PLUGIN_REFERENCE_ROOT = "references/upstream-plugins";

const RAW_UPSTREAM_PLUGIN_SPECS = [
  {
    pluginId: "opencode-antigravity-auth",
    packageName: "opencode-antigravity-auth",
    repoOwner: "NoeFabris",
    repoName: "opencode-antigravity-auth",
  },
  {
    pluginId: "opencode-cursor-oauth",
    packageName: "@playwo/opencode-cursor-oauth",
    repoOwner: "PoolPirate",
    repoName: "opencode-cursor",
  },
  {
    pluginId: "opencode-gemini-auth",
    packageName: "opencode-gemini-auth",
    repoOwner: "jenslys",
    repoName: "opencode-gemini-auth",
  },
  {
    pluginId: "opencode-qwencode-auth",
    packageName: "opencode-qwencode-auth",
    repoOwner: "gustavodiasdev",
    repoName: "opencode-qwencode-auth",
  },
  {
    pluginId: "opencode-agy-auth",
    packageName: "@anthonyhaussman/opencode-agy-auth",
    repoOwner: "anthonyhaussman",
    repoName: "opencode-agy-auth",
    allowMissingRepositoryMetadata: true,
  },
];

export const UPSTREAM_PLUGIN_SPECS = Object.freeze(
  RAW_UPSTREAM_PLUGIN_SPECS.map((spec) =>
    Object.freeze({
      ...spec,
      repo: `${spec.repoOwner}/${spec.repoName}`,
      referenceDir: `${UPSTREAM_PLUGIN_REFERENCE_ROOT}/${spec.pluginId}`,
    }),
  ),
);

export function getUpstreamPluginSpec(pluginId) {
  return UPSTREAM_PLUGIN_SPECS.find((spec) => spec.pluginId === pluginId) ?? null;
}

export function getUpstreamPluginIssueTitle(pluginId) {
  return `[check] ${pluginId} had update`;
}
