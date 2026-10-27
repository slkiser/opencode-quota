// Compiles every `src/**/*.tsx` to `dist/**/*.js` with Babel (Solid's universal JSX for OpenTUI)
// and deletes the `.jsx` files tsc leaves behind (tsconfig has `jsx: preserve`). Then writes
// `dist/tui.js`, the TUI entry in package.json, which re-exports `src/tui/index.tsx`.
// `src/gui/` is Solid for the browser, bundled by `build-gui.mjs`, so it is left out here.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");
const guiDir = path.join(srcDir, "gui");

async function listTsxFiles(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entryPath !== guiDir) found.push(...(await listTsxFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) found.push(entryPath);
  }
  return found;
}

for (const sourcePath of await listTsxFiles(srcDir)) {
  const distStem = path.join(distDir, path.relative(srcDir, sourcePath)).replace(/\.tsx$/, "");
  const transformed = await babel.transformAsync(await fs.readFile(sourcePath, "utf8"), {
    filename: sourcePath,
    configFile: false,
    babelrc: false,
    presets: [
      [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }],
      [typescriptPreset],
    ],
  });
  if (!transformed?.code) {
    throw new Error(`Babel transform returned empty output for ${sourcePath}`);
  }
  await fs.mkdir(path.dirname(distStem), { recursive: true });
  await fs.writeFile(`${distStem}.js`, `${transformed.code}\n`);
  await fs.rm(`${distStem}.jsx`, { force: true });
  await fs.rm(`${distStem}.jsx.map`, { force: true });
}

const reexport = `export { default } from "./tui/index.js";\n`;
await fs.writeFile(path.join(distDir, "tui.js"), reexport);
await fs.writeFile(path.join(distDir, "tui.d.ts"), reexport);
