import { resolve } from "path";

import type { QuotaStatusReportInput } from "./quota-dialog-commands.js";
import type { QuotaRuntimeClient } from "./quota-runtime-context.js";
import type { QuotaToastConfig } from "./types.js";

import { collectQuotaStatusReportInput } from "./quota-dialog-commands.js";
import { getQuotaProviderShape } from "./provider-metadata.js";
import { findGitWorktreeRoot, getEffectiveConfigRoot } from "./config-file-utils.js";
import {
  loadConfiguredOpenCodeConfig,
  loadConfiguredProviderIds,
} from "./opencode-config-providers.js";
import { getPackageVersion } from "./version.js";
import { buildQuotaStatusReport } from "./quota-status.js";
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";

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

interface CliStatusJson {
  version: string;
  generatedAt: string;
  config: {
    source: string;
    paths: string[];
    enabledProviders: string[] | string;
  };
  providers: Array<{
    id: string;
    enabled: boolean;
    available: boolean;
    matchesCurrentModel?: boolean;
  }>;
  pricing: {
    source: string;
  };
  liveProbes: Array<{
    providerId: string;
    ok: boolean;
  }>;
}

export function buildCliStatusJson(input: QuotaStatusReportInput): CliStatusJson {
  return {
    version: "",
    generatedAt:
      typeof input.generatedAtMs === "number" && input.generatedAtMs > 0
        ? new Date(input.generatedAtMs).toISOString()
        : new Date().toISOString(),
    config: {
      source: input.configSource,
      paths: input.configPaths,
      enabledProviders:
        input.enabledProviders === "auto" ? "auto" : [...input.enabledProviders],
    },
    providers: input.providerAvailability.map((p) => ({
      id: p.id,
      enabled: p.enabled,
      available: p.available,
      matchesCurrentModel: p.matchesCurrentModel,
    })),
    pricing: {
      source: input.pricingSnapshotSource,
    },
    liveProbes: (input.providerLiveProbes ?? []).map((probe) => ({
      providerId: probe.providerId,
      ok: probe.result.attempted && probe.result.errors.length === 0,
    })),
  };
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

function resolveCliRoots(cwd: string): { workspaceRoot: string; configRoot: string; fallbackDirectory: string } {
  const fallbackDirectory = resolve(cwd);
  const worktreeRoot = findGitWorktreeRoot(fallbackDirectory) ?? fallbackDirectory;
  const configRoot = getEffectiveConfigRoot(worktreeRoot);
  return {
    workspaceRoot: worktreeRoot,
    configRoot,
    fallbackDirectory,
  };
}

function createCliQuotaClient(params: { configRootDir: string }): QuotaRuntimeClient {
  let configPromise: Promise<Record<string, unknown>> | undefined;
  let providerIdsPromise: Promise<string[]> | undefined;

  return {
    config: {
      get: async () => {
        configPromise ??= loadConfiguredOpenCodeConfig({
          configRootDir: params.configRootDir,
        });
        return {
          data: (await configPromise) as {
            experimental?: { quotaToast?: Partial<QuotaToastConfig> };
            model?: string;
          },
        };
      },
      providers: async () => {
        providerIdsPromise ??= loadConfiguredProviderIds({
          configRootDir: params.configRootDir,
        });
        const ids = await providerIdsPromise;
        return {
          data: {
            providers: ids.map((id) => ({ id })),
          },
        };
      },
    },
  };
}

export async function runCliStatusCommand(options: RunCliStatusCommandOptions = {}): Promise<number> {
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
    const client = createCliQuotaClient({ configRootDir: roots.configRoot });
    const runtime = await resolveQuotaRuntimeContext({
      client,
      roots,
      includeSessionMeta: false,
    });

    if (!runtime.config.enabled) {
      writeLine(stderr, "Quota disabled in config (enabled: false).");
      return 1;
    }

    if (providerId) {
      runtime.config.enabledProviders = [providerId];
    }

    const generatedAtMs = Date.now();
    const input = await collectQuotaStatusReportInput(runtime, {
      generatedAtMs,
    });

    if (!input) {
      writeLine(stderr, "Quota disabled in config (enabled: false).");
      return 1;
    }

    if (parsed.json) {
      const json = buildCliStatusJson(input);
      const version = (await getPackageVersion()) ?? "unknown";
      json.version = version;

      const hasAvailable = input.providerAvailability.some((p) => p.available);
      if (!hasAvailable) {
        writeLine(stdout, JSON.stringify(json, null, 2));
        return 2;
      }

      writeLine(stdout, JSON.stringify(json, null, 2));
      return 0;
    }

    const report = await buildQuotaStatusReport(input);
    if (!report) {
      writeLine(stderr, "No quota status data available.");
      return 1;
    }

    writeLine(stdout, report);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(stderr, `Failed to show quota status: ${message}`);
    return 1;
  }
}
