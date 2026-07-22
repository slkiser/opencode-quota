const TRACKED_UPSTREAM_PLUGIN_IDENTITY_FIELDS = Object.freeze([
  "version",
  "packageName",
  "repo",
  "referenceDir",
  "npmUrl",
  "publishedAt",
]);

export function getTrackedUpstreamPluginIdentityDifferences(tracked, latest) {
  return TRACKED_UPSTREAM_PLUGIN_IDENTITY_FIELDS.filter(
    (field) => tracked?.[field] !== latest?.[field],
  );
}

export function isTrackedUpstreamPluginInSync(tracked, latest) {
  return getTrackedUpstreamPluginIdentityDifferences(tracked, latest).length === 0;
}
