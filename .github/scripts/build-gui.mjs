// Bundles the GUI part (`src/gui/index.tsx`) into `dist/gui-experimental.cjs`, the package's
// `./gui-experimental`, with OpenCode's GUI preset: Solid JSX for the browser, one CommonJS file,
// and the modules the OpenCode app provides (Solid, Effect, `@opencode/plugin/gui`, …) left out.
// Vite comes from Vite+ (`vite-plus` re-exports it). `configFile: false` keeps the repo's
// `vite.config.ts`, which is for formatting, linting and tests, out of this build.
//
// The window shares pure helpers with the server (`src/core/errors.ts`), whose modules also import
// Node built-ins they use elsewhere. A browser window has no Node, so a built-in import whose
// bindings the bundle never uses is dropped instead of kept as a bare `require("node:…")`; one
// the bundle does use stays, and the bundle test fails on it.
//
// `__OQ_VERSION__` is the package's version, for the window's title (`src/gui/version.ts`).
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gui } from "@opencode/plugin/gui/vite";
import { build } from "vite-plus";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { version } = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

await build({
  configFile: false,
  root: rootDir,
  logLevel: "warn",
  define: { __OQ_VERSION__: JSON.stringify(version) },
  build: {
    rollupOptions: {
      treeshake: { moduleSideEffects: (id, external) => !(external && isBuiltin(id)) },
    },
  },
  plugins: [gui({ entry: "src/gui/index.tsx", outFile: "dist/gui-experimental.cjs" })],
});
