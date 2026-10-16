import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, vi } from "vite-plus/test";

// Git hooks (for example the pre-push `pnpm verify`) export GIT_DIR, GIT_INDEX_FILE and similar
// variables. A git command run by a test would inherit them and write to the real repository
// instead of its temp folder, so no test process keeps any of them.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_NOSYSTEM = "1";

// The plugin reads and writes OpenCode's folders under the home folder and XDG folders, reads
// OpenCode's credential database, takes API keys from the environment and calls provider APIs.
// So every test file gets its own empty home folder, no OpenCode or credential variables, and a
// fetch that only reaches loopback servers.
const testHome = mkdtempSync(join(tmpdir(), "opencode-quota-test-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.XDG_CONFIG_HOME = join(testHome, ".config");
process.env.XDG_DATA_HOME = join(testHome, ".local", "share");
process.env.XDG_STATE_HOME = join(testHome, ".local", "state");
process.env.XDG_CACHE_HOME = join(testHome, ".cache");
process.env.APPDATA = join(testHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(testHome, "AppData", "Local");

const CREDENTIAL_ENV_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_COOKIE", "_PASSWORD"];
const CREDENTIAL_ENV_NAMES = [
  "CURSOR_ACP_HOME_DIR",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
];
for (const key of Object.keys(process.env)) {
  const upperKey = key.toUpperCase();
  if (
    upperKey.startsWith("OPENCODE_") ||
    CREDENTIAL_ENV_NAMES.includes(upperKey) ||
    CREDENTIAL_ENV_SUFFIXES.some((suffix) => upperKey.endsWith(suffix))
  ) {
    delete process.env[key];
  }
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const unguardedFetch = globalThis.fetch;

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

// Assigned directly (not vi.stubGlobal), so `vi.unstubAllGlobals()` restores this guard.
globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error(
      `Tests may not reach the network: blocked fetch to ${url.hostname}. Stub fetch or use a loopback server.`,
    );
  }
  return unguardedFetch(input, init);
};

afterEach(async () => {
  try {
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    pricing.__resetPricingSnapshotForTests();
  } catch {
    // best effort; tests that don't load pricing module should still clean up
  }

  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
