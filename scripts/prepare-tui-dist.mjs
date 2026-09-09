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
const tuiV2SourcePath = path.join(rootDir, "src", "tui-v2.tsx");
const tuiV2DistJsPath = path.join(rootDir, "dist", "tui-v2.js");
const tuiV2DistJsxPath = path.join(rootDir, "dist", "tui-v2.jsx");
const tuiV2DistJsxMapPath = path.join(rootDir, "dist", "tui-v2.jsx.map");

await fs.copyFile(sourcePath, distSourcePath);
for (const [inputPath, outputPath] of [
  [sourcePath, distJsPath],
  [tuiV2SourcePath, tuiV2DistJsPath],
]) {
  const source = await fs.readFile(inputPath, "utf8");
  const transformed = await babel.transformAsync(source, {
    filename: inputPath,
    configFile: false,
    babelrc: false,
    presets: [
      [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }],
      [typescriptPreset],
    ],
  });

  if (!transformed?.code) {
    throw new Error(`Babel transform returned empty output for ${inputPath}`);
  }

  await fs.writeFile(outputPath, `${transformed.code}\n`);
}

await fs.rm(distJsxPath, { force: true });
await fs.rm(distJsxMapPath, { force: true });
await fs.rm(tuiV2DistJsxPath, { force: true });
await fs.rm(tuiV2DistJsxMapPath, { force: true });
