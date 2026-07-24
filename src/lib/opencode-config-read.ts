import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import type { ConfigFileFormat } from "./config-file-utils.js";
import { parseJsonOrJsonc } from "./jsonc.js";

export interface OpenCodeConfigCandidate {
  path: string;
  format: ConfigFileFormat;
}

export type ReadOpenCodeConfigResult =
  | { state: "missing"; candidate: OpenCodeConfigCandidate }
  | { state: "invalid"; candidate: OpenCodeConfigCandidate }
  | { state: "parsed"; candidate: OpenCodeConfigCandidate; value: unknown };

export function buildOpenCodeConfigCandidates(params: {
  directories: readonly string[];
  formatOrder: readonly ConfigFileFormat[];
}): OpenCodeConfigCandidate[] {
  return params.directories.flatMap((directory) =>
    params.formatOrder.map((format) => ({
      path: join(directory, `opencode.${format}`),
      format,
    })),
  );
}

export function selectFirstExistingOpenCodeConfigCandidate(
  candidates: readonly OpenCodeConfigCandidate[],
): OpenCodeConfigCandidate | null {
  return candidates.find((candidate) => existsSync(candidate.path)) ?? null;
}

export async function readOpenCodeConfigCandidate(
  candidate: OpenCodeConfigCandidate,
): Promise<ReadOpenCodeConfigResult> {
  if (!existsSync(candidate.path)) {
    return { state: "missing", candidate };
  }

  try {
    const content = await readFile(candidate.path, "utf8");
    return {
      state: "parsed",
      candidate,
      value: parseJsonOrJsonc(content, candidate.format === "jsonc"),
    };
  } catch {
    return { state: "invalid", candidate };
  }
}
