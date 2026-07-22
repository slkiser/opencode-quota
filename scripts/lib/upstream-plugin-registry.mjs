import { writeFile } from "node:fs/promises";

const FETCH_TIMEOUT_MS = 15_000;
const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

function normalizeGitHubRepositorySlug(repository) {
  const rawUrl =
    typeof repository === "string"
      ? repository
      : repository && typeof repository === "object" && typeof repository.url === "string"
        ? repository.url
        : "";

  if (!rawUrl) return null;

  if (rawUrl.startsWith("github:")) {
    return rawUrl
      .slice("github:".length)
      .replace(/\.git$/i, "")
      .trim();
  }

  const normalizedUrl = rawUrl
    .replace(/^git\+/, "")
    .replace(/\.git$/i, "")
    .trim();

  try {
    const url = new URL(normalizedUrl);
    if (url.hostname !== "github.com") return null;
    return url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function buildNpmPackageUrl(packageName, version) {
  const encodedPackageName = packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://www.npmjs.com/package/${encodedPackageName}/v/${encodeURIComponent(version)}`;
}

export function normalizeLatestPublishedPluginVersion(spec, packument) {
  const latestVersion =
    packument &&
    typeof packument === "object" &&
    packument["dist-tags"] &&
    typeof packument["dist-tags"] === "object"
      ? packument["dist-tags"].latest
      : "";

  if (typeof latestVersion !== "string" || !latestVersion) {
    throw new Error(`Package ${spec.packageName} is missing a latest dist-tag.`);
  }

  const versionEntry =
    packument &&
    typeof packument === "object" &&
    packument.versions &&
    typeof packument.versions === "object"
      ? packument.versions[latestVersion]
      : null;

  if (!versionEntry || typeof versionEntry !== "object") {
    throw new Error(
      `Package ${spec.packageName} is missing metadata for version ${latestVersion}.`,
    );
  }

  const tarballUrl =
    versionEntry.dist &&
    typeof versionEntry.dist === "object" &&
    typeof versionEntry.dist.tarball === "string"
      ? versionEntry.dist.tarball
      : "";

  if (!tarballUrl) {
    throw new Error(`Package ${spec.packageName}@${latestVersion} is missing a dist.tarball URL.`);
  }

  const publishedAt =
    packument &&
    typeof packument === "object" &&
    packument.time &&
    typeof packument.time === "object"
      ? packument.time[latestVersion]
      : "";

  if (typeof publishedAt !== "string" || !publishedAt) {
    throw new Error(`Package ${spec.packageName}@${latestVersion} is missing a publish timestamp.`);
  }

  const repositoryMetadata = [versionEntry.repository, packument.repository].filter((repository) =>
    typeof repository === "string"
      ? repository.trim().length > 0
      : repository !== null && repository !== undefined,
  );

  for (const repository of repositoryMetadata) {
    const discoveredRepo = normalizeGitHubRepositorySlug(repository);
    if (!discoveredRepo) {
      throw new Error(
        `Package ${spec.packageName} has non-empty repository metadata that is not a GitHub repository.`,
      );
    }

    if (discoveredRepo !== spec.repo) {
      throw new Error(
        `Package ${spec.packageName} points to ${discoveredRepo}, but this repo expects ${spec.repo}. Update scripts/lib/upstream-plugin-specs.mjs if the upstream repo moved.`,
      );
    }
  }

  if (repositoryMetadata.length === 0 && !spec.allowMissingRepositoryMetadata) {
    throw new Error(
      `Package ${spec.packageName} is missing GitHub repository metadata. Set allowMissingRepositoryMetadata in scripts/lib/upstream-plugin-specs.mjs only after verifying the canonical repository from primary sources.`,
    );
  }

  return {
    pluginId: spec.pluginId,
    packageName: spec.packageName,
    publishedAt,
    referenceDir: spec.referenceDir,
    repo: spec.repo,
    repoUrl: `https://github.com/${spec.repo}`,
    tarballUrl,
    version: latestVersion,
    npmUrl: buildNpmPackageUrl(spec.packageName, latestVersion),
  };
}

export async function fetchLatestPublishedPluginVersion(spec) {
  const packument = await fetchJson(
    `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(spec.packageName)}`,
  );
  return normalizeLatestPublishedPluginVersion(spec, packument);
}

export async function downloadTarball(url, destinationPath) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}
