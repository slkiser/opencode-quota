/**
 * `opencode-quota show` and `status`, and the frame every terminal report runs in: the settings (prices
 * included), the logins from OpenCode's database, and the providers OpenCode knows.
 */
import { resolve } from "node:path";
import type { ProviderSourceHost } from "../core/provider-source.js";
import { loadSettings } from "../settings/index.js";
import { offProviderId, PROVIDER_IDS } from "../settings/schema.js";
import { hasAnthropicCredentialsConfigured } from "./anthropic.js";
import { API_KEY_VENDORS, resolveApiKeyLogin } from "./api-key-resolver.js";
import {
  buildCliShowJson,
  buildCliShowText,
  buildCliStatus,
  type CliReport,
} from "./cli-reports.js";
import { findGitWorktreeRoot } from "./config-file-utils.js";
import type { QuotaProviderContext } from "./entries.js";
import { usePricingSettings } from "./modelsdev-pricing.js";
import { createSqliteCredentialSource } from "./opencode-auth-sqlite.js";
import { bindCredentialSource } from "./opencode-auth.js";
import { loadConfiguredProviderIds } from "./opencode-config-providers.js";
import { getCanonicalQuotaProviderId } from "./provider-metadata.js";

interface RunCliCommandOptions {
  argv?: string[];
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

type CliCommand = "show" | "status";

type ParsedArgs =
  | { ok: true; providerId?: string; help: boolean; json: boolean; threshold?: number }
  | { ok: false; error: string };

const USAGE: Record<CliCommand, string> = {
  show: [
    "Usage:",
    "  npx @slkiser/opencode-quota show [--provider <provider-id>] [--json] [--threshold <pct>]",
    "",
    "Options:",
    "  --provider <provider-id>  Show quota for one provider",
    "  --json                    Machine-readable JSON output (the last known quota)",
    "  --threshold <pct>         With --json, exit 1 if any complete saved percentage is below",
    "                            <pct>% remaining (exit 2 if data is incomplete or not comparable)",
    "  --help, -h                Show help",
  ].join("\n"),
  status: [
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
    "  1  error",
    "  2  no comparable provider data (with --json only)",
  ].join("\n"),
};

const THRESHOLD_REDIRECT =
  "--threshold is not supported by status. For threshold exit codes, use: opencode-quota show --json --threshold <pct>";

function parseArgs(command: CliCommand, argv: string[]): ParsedArgs {
  let providerId: string | undefined;
  let json = false;
  let threshold: number | undefined;

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
      if (command === "status") return { ok: false, error: THRESHOLD_REDIRECT };
      let value: string | undefined;
      if (arg === "--threshold") {
        value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          return { ok: false, error: "Missing value for --threshold." };
        }
        index += 1;
      } else {
        value = arg.slice("--threshold=".length).trim();
        if (!value) {
          return { ok: false, error: "Missing value for --threshold." };
        }
      }
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        return { ok: false, error: "--threshold must be a positive finite number." };
      }
      threshold = num;
      continue;
    }

    if (arg === "--provider" || arg.startsWith("--provider=")) {
      const value = arg === "--provider" ? argv[index + 1] : arg.slice("--provider=".length).trim();
      if (!value || (arg === "--provider" && value.startsWith("-"))) {
        return { ok: false, error: "Missing value for --provider." };
      }
      if (providerId) {
        return { ok: false, error: "Specify --provider only once." };
      }
      providerId = value;
      if (arg === "--provider") index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${arg}` };
    }

    return { ok: false, error: `Unexpected argument: ${arg}` };
  }

  if (threshold !== undefined && !json) {
    return { ok: false, error: "--threshold requires --json." };
  }

  return { ok: true, providerId, help: false, json, threshold };
}

function resolveCliRoots(cwd: string): {
  workspaceRoot: string;
  configRoot: string;
  fallbackDirectory: string;
} {
  const fallbackDirectory = resolve(cwd);
  const worktreeRoot = findGitWorktreeRoot(fallbackDirectory) ?? fallbackDirectory;
  return {
    workspaceRoot: worktreeRoot,
    configRoot: worktreeRoot,
    fallbackDirectory,
  };
}

/** Logins OpenCode may not list as providers: the Claude CLI and the Kimi CLI. */
async function loadCliAuthenticatedProviderIds(anthropicBinaryPath: string): Promise<string[]> {
  const [anthropicConfigured, kimiGlobalAuth, kimiCnAuth] = await Promise.all([
    hasAnthropicCredentialsConfigured({ binaryPath: anthropicBinaryPath }),
    resolveApiKeyLogin(API_KEY_VENDORS["kimi-code-plan-global"]),
    resolveApiKeyLogin(API_KEY_VENDORS["kimi-code-plan-cn"]),
  ]);

  return [
    ...(anthropicConfigured ? ["anthropic"] : []),
    ...(kimiGlobalAuth.state === "configured" ? ["kimi-code-plan-global"] : []),
    ...(kimiCnAuth.state === "configured" ? ["kimi-code-plan-cn"] : []),
  ];
}

/** OpenCode's provider list without OpenCode: its config files plus the CLI logins. */
export function createCliQuotaClient(params: {
  configRootDir: string;
  anthropicBinaryPath: string;
}): QuotaProviderContext["client"] {
  let providerIdsPromise: Promise<string[]> | undefined;

  return {
    config: {
      providers: async () => {
        providerIdsPromise ??= (async () => {
          const [configuredIds, authenticatedIds] = await Promise.all([
            loadConfiguredProviderIds({ configRootDir: params.configRootDir }),
            loadCliAuthenticatedProviderIds(params.anthropicBinaryPath),
          ]);
          return [...new Set([...configuredIds, ...authenticatedIds])];
        })();
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

/** `--provider`: that provider only, as if the settings enabled only it. */
function withOnlyProvider(
  host: ProviderSourceHost,
  providerId: string | undefined,
): ProviderSourceHost {
  if (!providerId) return host;
  const loaded = host.settings();
  const providers = {
    ...loaded.settings.providers,
    off: PROVIDER_IDS.filter((id) => id !== offProviderId(providerId)),
  };
  const only = { ...loaded, settings: { ...loaded.settings, providers } };
  return { ...host, settings: () => only };
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

/**
 * Builds one `show` or `status` report in this process, for the folder the command runs in,
 * and prints it. It works with OpenCode closed: logins are read read-only from OpenCode's
 * database, and only while the report runs.
 */
async function runCliReport(params: {
  cwd: string;
  failurePrefix: "Failed to show quota" | "Failed to generate quota status";
  build: (host: ProviderSourceHost) => Promise<CliReport>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<number> {
  const unbind = bindCredentialSource(createSqliteCredentialSource());
  let unbindPricingSettings = () => {};
  try {
    const roots = resolveCliRoots(params.cwd);
    // The terminal reads the settings as they are; only OpenCode writes the v5 conversion.
    const loaded = await loadSettings({ projectDir: roots.workspaceRoot });
    unbindPricingSettings = usePricingSettings(() => loaded.settings.providers.pricing);
    const host: ProviderSourceHost = {
      client: createCliQuotaClient({
        configRootDir: roots.configRoot,
        anthropicBinaryPath: loaded.settings.providers.anthropic.binaryPath,
      }),
      workspaceRoot: roots.workspaceRoot,
      settings: () => loaded,
    };
    const report = await params.build(host);
    params.stdout.write(report.stdout);
    params.stderr.write(report.stderr);
    return report.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(params.stderr, `${params.failurePrefix}: ${message}`);
    return 1;
  } finally {
    unbind();
    unbindPricingSettings();
  }
}

/** Parses the arguments, prints the usage or an argument error, else runs the report. */
async function runCliCommand(
  command: CliCommand,
  options: RunCliCommandOptions,
  build: (
    host: ProviderSourceHost,
    args: { providerId?: string; json: boolean; threshold?: number },
  ) => Promise<CliReport>,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseArgs(command, options.argv ?? process.argv.slice(3));
  if (!parsed.ok) {
    writeLine(stderr, parsed.error);
    writeLine(stderr, USAGE[command]);
    return 1;
  }

  if (parsed.help) {
    writeLine(stdout, USAGE[command]);
    return 0;
  }

  const providerId = parsed.providerId ? getCanonicalQuotaProviderId(parsed.providerId) : undefined;
  if (parsed.providerId && !providerId) {
    writeLine(stderr, `Unknown provider: ${parsed.providerId}`);
    return 1;
  }

  return runCliReport({
    cwd: options.cwd ?? process.cwd(),
    failurePrefix: command === "show" ? "Failed to show quota" : "Failed to generate quota status",
    build: (host) => build(host, { ...parsed, providerId }),
    stdout,
    stderr,
  });
}

export function runCliShowCommand(options: RunCliCommandOptions = {}): Promise<number> {
  return runCliCommand("show", options, (host, args) => {
    const only = withOnlyProvider(host, args.providerId);
    return args.json
      ? buildCliShowJson({ host: only, threshold: args.threshold })
      : buildCliShowText(only);
  });
}

/** `status`: the same Quota Status diagnostics as /quota_status, without OpenCode. */
export function runCliStatusCommand(options: RunCliCommandOptions = {}): Promise<number> {
  return runCliCommand("status", options, (host, args) =>
    buildCliStatus({ host, providerId: args.providerId, json: args.json }),
  );
}
