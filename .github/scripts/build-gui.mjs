// Bundles the GUI part (`src/gui/index.tsx`) into `dist/gui-experimental.cjs`, the package's
// `./gui-experimental`, with OpenCode's GUI preset: Solid JSX for the browser, one CommonJS file,
// and the modules the OpenCode app provides (Solid, Effect, `@opencode/plugin/gui`, …) left out.
// Vite comes from Vite+ (`vite-plus` re-exports it). `configFile: false` keeps the repo's
// `vite.config.ts`, which is for formatting, linting and tests, out of this build.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gui } from "@opencode/plugin/gui/vite";
import { build } from "vite-plus";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

await build({
  configFile: false,
  root: rootDir,
  logLevel: "warn",
  plugins: [gui({ entry: "src/gui/index.tsx", outFile: "dist/gui-experimental.cjs" })],
});
