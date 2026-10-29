import { vi } from "vite-plus/test";

// Git hooks (for example the pre-push `pnpm verify`) export GIT_DIR,
// GIT_INDEX_FILE, and similar variables. A child git process that inherits them
// ignores its cwd and writes to the real repository instead of the temp folder.
function isGitEnvKey(key: string): boolean {
  return key.startsWith("GIT_");
}

/** process.env for a git child process that must only touch the repo in its cwd. */
export function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isGitEnvKey(key)));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1" };
}

/** Same isolation for git spawned inside code under test, which reads process.env itself. */
export function stubIsolatedGitEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (isGitEnvKey(key)) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
}
