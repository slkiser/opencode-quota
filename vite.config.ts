import { defineConfig } from "vite-plus";

export default defineConfig({
  // Tests import src/**/*.tsx and stub React.createElement, so their JSX compiles the classic way.
  oxc: { jsx: { runtime: "classic" } },
  fmt: {
    printWidth: 100,
    sortImports: { newlinesBetween: false, partitionByNewline: true },
    sortPackageJson: false,
    ignorePatterns: [
      "pnpm-lock.yaml",
      ".github/scripts/upstream-plugins/**",
      "src/data/modelsdev-pricing.min.json",
      "**/*.md",
    ],
  },
  lint: {
    ignorePatterns: ["dist/**", ".github/scripts/upstream-plugins/**"],
    plugins: ["typescript", "unicorn", "oxc", "react"],
    categories: { correctness: "error" },
    rules: {
      "array-callback-return": ["error", { checkForEach: true, allowVoid: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-case-declarations": "error",
      "no-cond-assign": ["error", "always"],
      "no-constructor-return": "error",
      "no-fallthrough": "error",
      "no-inner-declarations": "error",
      "no-label-var": "error",
      "no-redeclare": "error",
      "no-return-assign": ["error", "always"],
      "no-self-compare": "error",
      "oxc/misrefactored-assign-op": "error",
      "typescript/no-empty-interface": "error",
      // The TUI is Solid, not React: only the JSX check that applies to any JSX stays on.
      "react/jsx-no-comment-textnodes": "error",
      "react/globals": "off",
      "react/immutability": "off",
      "react/jsx-key": "off",
      "react/purity": "off",
    },
    overrides: [{ files: ["src/lib/display-sanitize.ts"], rules: { "no-control-regex": "off" } }],
  },
  // `.github/hooks/pre-commit` runs this on staged files and stages the fixes.
  staged: {
    "*.{js,cjs,mjs,jsx,ts,tsx,json,jsonc,css}": "vp check --fix --no-error-on-unmatched-pattern",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Tests that run git, build, or open SQLite take 7-11 s on the Windows CI runner and on a
    // busy machine, past Vitest's 5 s default. A test that really hangs still fails.
    testTimeout: 30_000,
  },
});
