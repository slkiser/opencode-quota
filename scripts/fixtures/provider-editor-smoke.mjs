import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const [root, cli] = process.argv.slice(2);
const config = path.join(root, "isolated-config");
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
};
const input = path.join(root, "definition.json");
const definition = {
  id: "custom-fixture",
  providerId: "fixture",
  mode: "local-estimate",
  windows: [{ id: "daily", type: "utc-day", requestLimit: 10 }],
};
writeFileSync(input, JSON.stringify(definition));
const target = path.join(config, "opencode", "opencode-quota", "quota-toast.json");
mkdirSync(path.dirname(target), { recursive: true });
const original = '{\n // retained comment\n "unrelated":"DO_NOT_PRINT_PRIVATE",\n}\n';
writeFileSync(target, original, { mode: 0o640 });
const run = (...args) =>
  execFileSync(process.execPath, [cli, "provider", ...args], { cwd: root, env, encoding: "utf8" });
const preview = run("add", input);
assert.equal(readFileSync(target, "utf8"), original);
assert.ok(!preview.includes("DO_NOT_PRINT_PRIVATE"));
const digest = preview.match(/Preview SHA256: ([a-f0-9]{64})/)[1];
const denied = spawnSync(process.execPath, [cli, "provider", "add", input, "--write"], {
  cwd: root,
  env,
  encoding: "utf8",
});
assert.equal(denied.status, 1);
run("add", input, "--write", "--expect", digest);
const updated = readFileSync(target, "utf8");
assert.ok(updated.includes("retained comment"));
assert.ok(updated.includes('"custom-fixture"'));
assert.ok(updated.includes("DO_NOT_PRINT_PRIVATE"));
if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o640);
const backup = readdirSync(path.dirname(target)).find((n) => n.includes("before-provider-"));
assert.equal(readFileSync(path.join(path.dirname(target), backup), "utf8"), original);
assert.ok(run("add", input).includes("Already configured"));
assert.ok(run("status").includes("custom-fixture: local-estimate"));
// Recover only the isolated fixture; no user settings are read or changed.
writeFileSync(target, readFileSync(path.join(path.dirname(target), backup)));
assert.equal(readFileSync(target, "utf8"), original);
assert.equal(existsSync(`${target}.provider.lock`), false);
console.log(
  "Installed provider editor passed: explicit preview/write, JSONC, private backup, idempotency and rollback.",
);
