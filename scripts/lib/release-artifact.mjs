import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const RELEASE_ARTIFACT_MANIFEST = "release-artifact.json";

async function sha256(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

export async function writeReleaseArtifactManifest(artifactDir, tarballPath) {
  const filename = path.basename(tarballPath);
  const manifest = {
    version: 1,
    filename,
    sha256: await sha256(tarballPath),
  };

  await writeFile(
    path.join(artifactDir, RELEASE_ARTIFACT_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return manifest;
}

export async function verifyReleaseArtifact(inputDir) {
  const artifactDir = path.resolve(inputDir);
  const artifactStat = await stat(artifactDir);
  if (!artifactStat.isDirectory()) {
    throw new Error(`Release artifact input must be a directory: ${artifactDir}`);
  }

  const files = await readdir(artifactDir);
  const tarballs = files.filter((file) => file.endsWith(".tgz")).sort();
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one .tgz in ${artifactDir}; found ${tarballs.length}.`);
  }

  const rawManifest = await readFile(path.join(artifactDir, RELEASE_ARTIFACT_MANIFEST), "utf8");
  const manifest = JSON.parse(rawManifest);
  const keys = Object.keys(manifest).sort();
  if (
    keys.join(",") !== "filename,sha256,version" ||
    manifest.version !== 1 ||
    typeof manifest.filename !== "string" ||
    typeof manifest.sha256 !== "string"
  ) {
    throw new Error(`${RELEASE_ARTIFACT_MANIFEST} has an invalid shape.`);
  }

  const filename = tarballs[0];
  if (manifest.filename !== filename || path.basename(manifest.filename) !== manifest.filename) {
    throw new Error(
      `${RELEASE_ARTIFACT_MANIFEST} names ${manifest.filename}, but the artifact is ${filename}.`,
    );
  }

  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error(`${RELEASE_ARTIFACT_MANIFEST} has an invalid SHA-256 digest.`);
  }

  const tarballPath = path.join(artifactDir, filename);
  const actualSha256 = await sha256(tarballPath);
  if (actualSha256 !== manifest.sha256) {
    throw new Error(
      `Release artifact SHA-256 mismatch for ${filename}: expected ${manifest.sha256}, received ${actualSha256}.`,
    );
  }

  return {
    artifactDir,
    filename,
    sha256: actualSha256,
    tarballPath,
  };
}
