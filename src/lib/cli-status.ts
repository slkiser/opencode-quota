import type { QuotaRuntimeClient } from "./quota-runtime-context.js";

import { getQuotaProviderShape } from "./provider-metadata.js";
import { resolveQuotaRuntimeContext } from "./quota-runtime-context.js";
import { buildStatusReportData, type QuotaStatusReportPayload } from "./quota-dialog-commands.js";
import { createCliQuotaClient, resolveCliRoots } from "./cli-show.js";

export interface RunCliStatusCommandOptions {
  argv?: string[];
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

type ParsedStatusArgs =
  | { ok: true; providerId?: string; help: boolean; json: boolean }
  | { ok: false; error: string };

const STATUS_USAGE = [
  "Usage:",
  "  npx @slkiser/opencode-quota status [--provider <provider-id>] [--json]",
  "",
  "Print the same Quota Status diagnostics as the /quota_status slash command,",
  "without launching OpenCode.",
  "",
  "Options:",
  "  --provider <provider-id>  Restrict provider availability and live probes to one provider",
  "  --json                    Machine-readable JSON output:",
  "                            { version, generatedAt, config, providers, pricing, liveProbes }",
  "  --help, -h                Show help",
  "",
  "Exit codes:",
  "  0  success",
  "  1  error or quota disabled (enabled: false)",
  "  2  no comparable provider data (with --json only)",
].join("\n");

const THRESHOLD_REDIRECT =
  "--threshold is not supported by status. For threshold exit codes, use: opencode-quota show --json --threshold <pct>";

function parseStatusArgs(argv: string[]): ParsedStatusArgs {
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
      return { ok: false, error: THRESHOLD_REDIRECT };
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

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

function hasComparableProviderData(payload: QuotaStatusReportPayload): boolean {
  return payload.liveProbes.length > 0;
}

export async function runCliStatusCommand(
  options: RunCliStatusCommandOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(3);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseStatusArgs(argv);
  if (!parsed.ok) {
    writeLine(stderr, parsed.error);
    writeLine(stderr, STATUS_USAGE);
    return 1;
  }

  if (parsed.help) {
    writeLine(stdout, STATUS_USAGE);
    return 0;
  }

  const providerId = parsed.providerId ? getQuotaProviderShape(parsed.providerId)?.id : undefined;
  if (parsed.providerId && !providerId) {
    writeLine(stderr, `Unknown provider: ${parsed.providerId}`);
    return 1;
  }

  try {
    const roots = resolveCliRoots(options.cwd ?? process.cwd());
    const client: QuotaRuntimeClient = createCliQuotaClient({ configRootDir: roots.configRoot });
    const runtime = await resolveQuotaRuntimeContext({
      client,
      roots,
      includeSessionMeta: false,
    });

    if (!runtime.config.enabled) {
      writeLine(stderr, "Quota disabled in config (enabled: false).");
      return 1;
    }

    const data = await buildStatusReportData({
      runtime,
      generatedAtMs: Date.now(),
      providerFilterId: providerId,
    });

    if (!data.output || !data.payload) {
      writeLine(stderr, "Quota disabled in config (enabled: false).");
      return 1;
    }

    if (parsed.json) {
      writeLine(stdout, JSON.stringify(data.payload, null, 2));
      return hasComparableProviderData(data.payload) ? 0 : 2;
    }

    writeLine(stdout, data.output);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(stderr, `Failed to generate quota status: ${message}`);
    return 1;
  }
}
