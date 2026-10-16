export const UPSTREAM_PLUGIN_REFERENCE_ROOT = "scripts/upstream-plugins";

const RAW_UPSTREAM_PLUGIN_SPECS = [
  {
    pluginId: "cursor-opencode-provider",
    packageName: "cursor-opencode-provider",
    distTag: "latest",
    repoOwner: "oakimov",
    repoName: "cursor-opencode-provider",
  },
  {
    pluginId: "opencode-gemini-auth",
    packageName: "opencode-gemini-auth",
    distTag: "latest",
    repoOwner: "jenslys",
    repoName: "opencode-gemini-auth",
  },
  {
    pluginId: "opencode-agy-auth",
    packageName: "@anthonyhaussman/opencode-agy-auth",
    // The OpenCode 2 build ships only on the alpha dist-tag; `latest` is the OpenCode 1 build.
    distTag: "alpha",
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
