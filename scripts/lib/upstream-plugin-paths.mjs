import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(libDir, "../..");
export const upstreamPluginReferenceRoot = path.join(repoRoot, "scripts", "upstream-plugins");
export const upstreamPluginLockPath = path.join(upstreamPluginReferenceRoot, "lock.json");
