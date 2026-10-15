import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import {
  isRecord,
  validateRemoteDefinitions,
  type RemoteQuotaDefinition,
} from "./quota-provider-definitions.js";
export interface CustomDefinitionLoad {
  definitions: RemoteQuotaDefinition[];
  path?: string;
  issues: Array<{ path: string; key: string; message: string }>;
}
/** Only trusted user/global roots; neither cwd, SDK merged config nor workspace definitions. */
export function loadCustomQuotaDefinitions(): CustomDefinitionLoad {
  let paths: string[];
  try {
    paths = getOpencodeRuntimeDirCandidates().configDirs.flatMap((root) => [
      join(root, "opencode-quota", "quota-toast.json"),
      join(root, "opencode.jsonc"),
      join(root, "opencode.json"),
    ]);
  } catch {
    return { definitions: [], issues: [] };
  }
  for (const path of [...new Set(paths)]) {
    try {
      let info;
      try {
        info = statSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() || info.size > 65536) throw new Error("Invalid custom config size");
      const root = parseJsonOrJsonc(readFileSync(path, "utf8"), true);
      if (!isRecord(root)) throw new Error("Invalid custom config root");
      const config = path.endsWith("quota-toast.json") ? root : root.experimental?.quotaToast;
      if (!isRecord(config) || !Object.hasOwn(config, "quotaProviders")) continue;
      return { definitions: validateRemoteDefinitions(config.quotaProviders), path, issues: [] };
    } catch {
      return {
        definitions: [],
        path,
        issues: [
          {
            path,
            key: "quotaProviders",
            message: "Custom definitions unavailable or invalid; all custom sources disabled",
          },
        ],
      };
    }
  }
  return { definitions: [], issues: [] };
}
