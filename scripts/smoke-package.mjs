import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, withConsumer } from "./lib/package-consumer.mjs";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await withConsumer(process.argv[2], async (root) => {
  // Executing inside an independent consumer prevents source-tree fallbacks
  // and development dependencies from masking missing package payloads.
  const script = path.join(root, "verify.mjs");
  await writeFile(
    script,
    `
    import assert from "node:assert/strict";
    import { access, readFile } from "node:fs/promises";
    import path from "node:path";
    import { fileURLToPath } from "node:url";
    const name = ${JSON.stringify(pkg.name)};
    await import(name);
    await import(name + "/server");
    const tui = fileURLToPath(import.meta.resolve(name + "/tui"));
    assert.ok(tui.endsWith("/dist/tui.tsx"));
    assert.ok((await readFile(tui, "utf8")).includes("const pluginModule"));
    const main = fileURLToPath(import.meta.resolve(name + "/gui"));
    const packageRoot = path.resolve(main, "../../..");
    for (const relative of [
      "dist/gui/renderer/index.html", "dist/gui/renderer/app.js",
      "dist/gui/renderer/styles/app.css", "dist/gui/preload.mjs",
      "dist/data/modelsdev-pricing.min.json", "dist/dashboard/schema.sql",
    ]) await access(path.join(packageRoot, relative));
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, ${JSON.stringify(pkg.version)});
    assert.equal(manifest.engines.node, ">=20.0.0");
    console.log("Installed package exports and GUI payload passed on " + process.version);
  `,
  );
  await run(process.execPath, [script], { cwd: root });
  await run(
    process.execPath,
    [
      fileURLToPath(new URL("fixtures/provider-editor-smoke.mjs", import.meta.url)),
      root,
      path.join(root, "node_modules", pkg.name, "dist/bin/opencode-quota.js"),
    ],
    { cwd: root },
  );
  await run(
    process.execPath,
    [path.join(root, "node_modules", pkg.name, "dist/bin/opencode-quota.js"), "--help"],
    {
      cwd: root,
    },
  );
});
