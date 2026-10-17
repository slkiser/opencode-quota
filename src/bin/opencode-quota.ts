#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInitInstaller } from "../lib/init-installer.js";

const USAGE = [
  "Usage:",
  "  npx @thanhndv212/token-watcher init [--sync-legacy-config]",
  "  npx @thanhndv212/token-watcher show [--provider <provider-id>] [--json] [--threshold <pct>]",
  "  npx @thanhndv212/token-watcher dashboard [--port <port>]",
  "  npx @thanhndv212/token-watcher gui",
  "  npx @thanhndv212/token-watcher provider add <definition.json> [--write --expect <preview-sha256>]",
  "  npx @thanhndv212/token-watcher provider status",
  "  npx @thanhndv212/token-watcher --help",
  "",
  "Commands:",
  "  init      Run the interactive quota installer",
  "            --sync-legacy-config also writes experimental.quotaToast",
  "  show      Print a quick quota glance",
  "            --json               Machine-readable JSON output (reads from cache)",
  "            --threshold <pct>    With --json, exit 1 if below <pct>%, 2 if no cached quota",
  "            --provider <id>      Filter to one provider",
  "  dashboard Start the headless quota dashboard JSON API server (no UI —",
  "            use `gui` for that; this is for programmatic/headless access)",
  "            --port <port>        Port to listen on (default: 3939)",
  "  gui       Launch the desktop menubar GUI app (requires Electron)",
].join("\n");

function printUsage(): void {
  console.log(USAGE);
}

function resolveCliPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return resolve(filePath);
  }
}

export function cliShouldRunMain(
  argv1: string | undefined = process.argv[1],
  modulePath: string = fileURLToPath(import.meta.url),
  resolvePath: (filePath: string) => string = resolveCliPath,
): boolean {
  if (!argv1) {
    return false;
  }

  return resolvePath(modulePath) === resolvePath(argv1);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  if (!command) {
    printUsage();
    return 1;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return 0;
  }

  if (command === "init") {
    if (rest.length === 0) {
      return await runInitInstaller();
    }
    if (rest.length === 1 && rest[0] === "--sync-legacy-config") {
      return await runInitInstaller({ syncLegacyConfig: true });
    }
  }

  if (command === "provider") {
    const { runCliProvider } = await import("../lib/cli-provider.js");
    return runCliProvider(rest);
  }

  if (command === "show") {
    const { runCliShowCommand } = await import("../lib/cli-show.js");
    return await runCliShowCommand({ argv: rest });
  }

  if (command === "dashboard") {
    const { spawn } = await import("child_process");
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const dashboardPath = join(__dirname, "dashboard.js");

    // Parse port argument
    const portIndex = rest.indexOf("--port");
    const port = portIndex !== -1 ? rest[portIndex + 1] : "3939";

    console.log(`Starting Token Watcher Dashboard on http://localhost:${port}...`);
    console.log("Press Ctrl+C to stop the server.");

    // Plain "node" — when this command is spawned by the packaged Electron app
    // (src/gui/main.ts's startDashboardServer), that parent process already
    // resolves a real system node and prepends its directory to PATH before
    // spawning us, so this bare lookup resolves correctly by inheritance.
    const child = spawn("node", [dashboardPath, "--port", port], {
      stdio: "inherit",
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      console.error("Error starting dashboard server:", err);
      process.exit(1);
    });

    // Keep process alive
    await new Promise<void>((resolve) => {
      child.on("exit", (code) => {
        process.exitCode = code || 0;
        resolve();
      });
    });

    return 0;
  }

  if (command === "gui") {
    const { spawn } = await import("child_process");
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");
    const { existsSync } = await import("fs");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const guiMainPath = join(__dirname, "..", "gui", "main.js");

    // Resolve the project root for pricing sync
    // dist/bin/ → dist/ → project root → opencode-quota/
    const projectRoot = join(__dirname, "..", "..");
    const repoPricingDir = join(projectRoot, "opencode-quota");

    // Set OPENCODE_QUOTA_SYNC_DIR so the GUI picks up repo-synced pricing overrides.
    // The env var is expected to point to opencode-quota/token-sync/; pricing
    // code derives the parent opencode-quota/ directory from it.
    const tokenSyncDir = join(repoPricingDir, "token-sync");
    if (existsSync(tokenSyncDir)) {
      process.env.OPENCODE_QUOTA_SYNC_DIR = tokenSyncDir;
    }

    // Try to find electron
    const electronCmd = process.env.ELECTRON_PATH || "electron";

    // Allow passing extra args to Electron (e.g. --no-sandbox on Linux)
    const electronArgs = process.env.ELECTRON_ARGS
      ? process.env.ELECTRON_ARGS.split(" ").filter(Boolean)
      : [];

    // Auto-enable --no-sandbox on Linux when not explicitly requested
    if (
      process.platform === "linux" &&
      !electronArgs.includes("--no-sandbox") &&
      !electronArgs.includes("--no-sandbox=true")
    ) {
      electronArgs.push("--no-sandbox");
    }

    const spawnArgs = [...electronArgs, guiMainPath, ...rest];

    console.log("Launching Token Watcher GUI...");
    console.log(`  Electron: ${electronCmd}`);
    if (electronArgs.length) console.log(`  Args:     ${electronArgs.join(" ")}`);
    console.log(`  Main:     ${guiMainPath}`);

    const child = spawn(electronCmd, spawnArgs, {
      stdio: "inherit",
      detached: true,
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error("");
        console.error("Error: Electron not found.");
        console.error("");
        console.error("Install it with one of:");
        console.error("  npm install -g electron");
        console.error("  npx electron <path-to-gui-main.js>");
        console.error("");
        console.error("Or set ELECTRON_PATH to your electron binary.");
        process.exit(1);
      }
      throw err;
    });

    child.unref();
    return 0;
  }

  printUsage();
  return 1;
}

if (cliShouldRunMain()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
