import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, withConsumer } from "./lib/package-consumer.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await withConsumer(process.argv[2], async (root) => {
  const profile = path.join(root, "profile");
  await mkdir(profile);
  const env = {
    ...process.env,
    HOME: profile,
    SHELL: "/bin/sh",
    XDG_CONFIG_HOME: path.join(profile, "config"),
    XDG_DATA_HOME: path.join(profile, "data"),
    XDG_CACHE_HOME: path.join(profile, "cache"),
    XDG_STATE_HOME: path.join(profile, "state"),
    QUOTA_SMOKE_MAIN: path.join(root, "node_modules", pkg.name, "dist/gui/main.js"),
    QUOTA_SMOKE_VERSION: pkg.version,
    OPENCODE_QUOTA_NODE_BINARY: process.execPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENCODE_CONFIG_DIR;
  const settingsDir = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode-quota");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, "quota-toast.json"),
    JSON.stringify({
      enabledProviders: ["openai"],
      cursorPlan: "pro",
      minIntervalMs: 1,
      requestTimeoutMs: 9000,
      pricingSnapshot: { source: "bundled", autoRefresh: 0 },
    }),
  );
  await mkdir(path.join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
  await writeFile(
    path.join(env.XDG_DATA_HOME, "opencode", "auth.json"),
    JSON.stringify({
      openai: { type: "oauth", access: "gui-smoke-fixture-token", expires: Date.now() + 3_600_000 },
    }),
  );
  // Real usage fixture for the separate Node history/budget helper.
  const { DatabaseSync } = await import("node:sqlite");
  const usageDb = new DatabaseSync(path.join(env.XDG_DATA_HOME, "opencode", "opencode.db"));
  usageDb.exec(
    "CREATE TABLE session (id TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER)",
  );
  usageDb.exec(
    "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  const writeMessage = usageDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  for (const [i, age] of [0.5, 2, 10, 40].entries()) {
    const timestamp = Date.now() - age * 86_400_000;
    writeMessage.run(
      `msg_${i}`,
      `ses_${i}`,
      timestamp,
      timestamp,
      JSON.stringify({
        role: "assistant",
        providerID: "fixture",
        modelID: "no-price",
        tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } },
        time: { created: timestamp },
      }),
    );
  }
  usageDb.close();
  // A launch-directory sidecar must not override global settings.
  await mkdir(path.join(root, "opencode-quota"));
  await writeFile(
    path.join(root, "opencode-quota", "quota-toast.json"),
    JSON.stringify({ enabledProviders: ["cursor"] }),
  );
  const args = [fileURLToPath(new URL("fixtures/gui-smoke.mjs", import.meta.url))];
  if (process.platform === "linux") args.push("--no-sandbox");
  await run(electron, args, { cwd: root, env, timeout: 60_000 });
});
