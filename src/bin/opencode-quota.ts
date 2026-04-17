#!/usr/bin/env node

import { pathToFileURL } from "url";

import { runInitInstaller } from "../lib/init-installer.js";

const USAGE = [
  "Usage:",
  "  npx @slkiser/opencode-quota init",
  "  npx @slkiser/opencode-quota --help",
  "",
  "Commands:",
  "  init    Run the interactive quota installer",
].join("\n");

function printUsage(): void {
  console.log(USAGE);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  if (!command) {
    printUsage();
    return 1;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return 0;
  }

  if (command === "init" && rest.length === 0) {
    return await runInitInstaller();
  }

  printUsage();
  return 1;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
