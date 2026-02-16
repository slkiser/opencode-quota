import { existsSync } from "fs";

export function pickFirstExistingPath(candidates: string[]): string {
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  // Deterministic fallback for diagnostics.
  return candidates[0] ?? "";
}
