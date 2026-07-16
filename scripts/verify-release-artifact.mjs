import path from "node:path";

import { verifyReleaseArtifact } from "./lib/release-artifact.mjs";

const artifactDir = path.resolve(process.argv[2] ?? "package-artifacts");
const artifact = await verifyReleaseArtifact(artifactDir);
console.log(`Release artifact verified: ${artifact.filename} (sha256 ${artifact.sha256}).`);
