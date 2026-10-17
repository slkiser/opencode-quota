import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

if (process.platform !== "darwin") throw new Error("This installer requires macOS");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(
  process.argv[2] ||
    path.join(
      root,
      process.arch === "arm64"
        ? "release/mac-arm64/Token Watcher.app"
        : "release/mac/Token Watcher.app",
    ),
);
const destination = "/Applications/Token Watcher.app";
const legacy = "/Applications/OpenCode Quota.app";
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const identifier = execFileSync(
  "/usr/libexec/PlistBuddy",
  ["-c", "Print :CFBundleIdentifier", path.join(source, "Contents/Info.plist")],
  { encoding: "utf8" },
).trim();
if (identifier !== "io.github.thanhndv212.tokenwatcher")
  throw new Error("Unexpected application identity");
const commands = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).split("\n");
if (
  commands.some((command) =>
    [destination, legacy].some((app) => command.startsWith(app + "/Contents/MacOS/")),
  )
) {
  throw new Error(
    "Quit Token Watcher and OpenCode Quota before installing; user data will be retained",
  );
}
const nonce = randomUUID();
const backupDir = path.join(root, "release/install-backups", nonce);
await mkdir(backupDir, { recursive: true, mode: 0o700 });
const incoming = `/Applications/.Token-Watcher-install-${nonce}.app`;
const moved = [];
const archives = [];
try {
  run("ditto", [source, incoming]);
  run("codesign", ["--verify", "--deep", "--strict", incoming]);
  for (const app of [destination, legacy]) {
    if (!existsSync(app)) continue;
    const expected = app === legacy ? "ai.opencode.quota" : "io.github.thanhndv212.tokenwatcher";
    const existingId = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", path.join(app, "Contents/Info.plist")],
      { encoding: "utf8" },
    ).trim();
    if (existingId !== expected) throw new Error(`Refusing to replace unrelated app at ${app}`);
    const archive = path.join(backupDir, path.basename(app) + ".zip");
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
    run("unzip", ["-t", "-qq", archive]);
    archives.push(archive);
  }
  for (const app of [destination, legacy]) {
    if (!existsSync(app)) continue;
    const previous = `/Applications/.Token-Watcher-previous-${randomUUID()}.app`;
    await rename(app, previous);
    moved.push({ app, previous });
  }
  await rename(incoming, destination);
} catch (error) {
  for (const { app, previous } of moved.reverse()) await rename(previous, app);
  await rm(incoming, { recursive: true, force: true });
  throw error;
}
// App rollback archives were verified before any old application was moved.
for (const { previous } of moved) await rm(previous, { recursive: true, force: true });
await writeFile(
  path.join(backupDir, "INSTALL.json"),
  JSON.stringify(
    {
      application: destination,
      archives,
      installedAt: new Date().toISOString(),
      data: "Existing settings, credentials, caches and databases remain in their legacy paths",
    },
    null,
    2,
  ) + "\n",
);
console.log(`Installed ${destination}; rollback archives: ${backupDir}`);
