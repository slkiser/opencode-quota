#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main, cliShouldRunMain } from "./opencode-quota.js";

if (cliShouldRunMain(process.argv[1], fileURLToPath(import.meta.url))) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
