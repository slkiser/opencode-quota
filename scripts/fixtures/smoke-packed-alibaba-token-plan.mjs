import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("@slkiser/opencode-quota"))),
  "..",
);

function packageImport(relativePath) {
  return import(pathToFileURL(path.join(packageRoot, "dist", relativePath)));
}

const workdir = await mkdtemp(path.join(tmpdir(), "opencode-quota-alibaba-token-plan-smoke-"));
const fakeBin = path.join(workdir, "bin");
const argvLog = path.join(workdir, "argv.json");
const fakeBl = path.join(fakeBin, "bl");

await mkdir(fakeBin, { recursive: true });
await writeFile(
  fakeBl,
  `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({
  per1MonthPercentage: 0.25,
  per1MonthResetTime: 1714000000000
}));
`,
  { mode: 0o755 },
);
await chmod(fakeBl, 0o755);
await writeFile(argvLog, "");

try {
  const { getProviders } = await packageImport("providers/registry.js");
  const { queryAlibabaTokenPlanQuota } = await packageImport("lib/alibaba.js");

  const providers = getProviders();
  const provider = providers.find((entry) => entry.id === "alibaba-token-plan");
  assert.ok(provider, "packed registry is missing alibaba-token-plan");
  assert.equal(provider.cachePolicy?.kind, "resolved-auth");
  assert.equal(
    providers.find((entry) => entry.id === "alibaba-coding-plan")?.id,
    "alibaba-coding-plan",
  );

  const isolatedCwd = path.join(workdir, "cwd");
  await mkdir(isolatedCwd, { recursive: true });
  await mkdir(path.join(workdir, "tmp"), { recursive: true });
  await mkdir(path.join(workdir, "home"), { recursive: true });
  const emptyPathResult = await queryAlibabaTokenPlanQuota({
    runtime: {
      cwd: isolatedCwd,
      pathEnv: "",
      env: { PATH: "", HOME: path.join(workdir, "home") },
    },
  });
  assert.equal(emptyPathResult.ok, false);
  // win32 is a supported platform; an empty PATH resolves no executable on any of them.
  assert.equal(emptyPathResult.error.kind, "executable_not_found");

  if (process.platform !== "win32") {
    const live = await queryAlibabaTokenPlanQuota({
      runtime: {
        cwd: isolatedCwd,
        pathEnv: `${fakeBin}${path.delimiter}${path.dirname(process.execPath)}`,
        tmpdir: path.join(workdir, "tmp"),
        homedir: path.join(workdir, "home"),
        env: {
          PATH: `${fakeBin}${path.delimiter}${path.dirname(process.execPath)}`,
          HOME: path.join(workdir, "home"),
        },
      },
    });
    assert.equal(live.ok, true);
    assert.equal(live.monthly?.percentRemaining, 75);
    const argv = JSON.parse(await readFile(argvLog, "utf8"));
    assert.deepEqual(argv, ["usage", "token-plan", "--output", "json"]);
  }

  console.log("Packed Alibaba Token Plan smoke passed.");
} finally {
  await rm(workdir, { recursive: true, force: true });
}
