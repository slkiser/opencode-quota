import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const sourcePath = path.join(rootDir, "src", "tui.tsx");
const distSourcePath = path.join(rootDir, "dist", "tui.tsx");
const distJsPath = path.join(rootDir, "dist", "tui.js");
const distJsxPath = path.join(rootDir, "dist", "tui.jsx");
const distJsxMapPath = path.join(rootDir, "dist", "tui.jsx.map");

await fs.copyFile(sourcePath, distSourcePath);
const source = await fs.readFile(sourcePath, "utf8");
const transformed = await babel.transformAsync(source, {
  filename: sourcePath,
  configFile: false,
  babelrc: false,
  presets: [
    [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }],
    [typescriptPreset],
  ],
});

if (!transformed?.code) {
  throw new Error("Babel transform returned empty output");
}

await fs.writeFile(distJsPath, `${transformed.code}\n`);
await fs.rm(distJsxPath, { force: true });
await fs.rm(distJsxMapPath, { force: true });
