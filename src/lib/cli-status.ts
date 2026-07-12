import { resolve } from "path";

import type { QuotaStatusReportInput } from "./quota-dialog-commands.js";

export interface RunCliStatusCommandOptions {
  argv?: string[];
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

type ParsedStatusArgs =
  | { ok: true; providerId?: string; help: boolean; json: boolean }
  | { ok: false; error: string };

export const STATUS_USAGE = [
  "Usage:",
  "  npx @slkiser/opencode-quota status [--provider <provider-id>] [--json]",
  "",
  "Options:",
  "  --provider <provider-id>  Show diagnostics for one provider",
  "  --json                    Machine-readable JSON output",
  "  --help, -h                Show help",
].join("\n");

export function parseStatusArgs(argv: string[]): ParsedStatusArgs {
  let providerId: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      return { ok: true, help: true, json: false };
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--threshold" || arg.startsWith("--threshold=")) {
      return {
        ok: false,
        error: "--threshold is not supported by status. Use 'show --json --threshold' instead.",
      };
    }

    if (arg === "--provider") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        return { ok: false, error: "Missing value for --provider." };
      }
      if (providerId) {
        return { ok: false, error: "Specify --provider only once." };
      }
      providerId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length).trim();
      if (!value) {
        return { ok: false, error: "Missing value for --provider." };
      }
      if (providerId) {
        return { ok: false, error: "Specify --provider only once." };
      }
      providerId = value;
      continue;
    }

    if (arg.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${arg}` };
    }

    return { ok: false, error: `Unexpected argument: ${arg}` };
  }

  return { ok: true, providerId, help: false, json };
}
