export function isTrackedUpstreamPluginInSync(tracked, latest) {
  return (
    tracked.version === latest.version &&
    tracked.packageName === latest.packageName &&
    tracked.repo === latest.repo &&
    tracked.referenceDir === latest.referenceDir &&
    tracked.npmUrl === latest.npmUrl &&
    tracked.publishedAt === latest.publishedAt
  );
}
