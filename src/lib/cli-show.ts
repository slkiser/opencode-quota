import { resolve } from "path";

import type { QuotaRuntimeClient } from "./quota-runtime-context.js";
import type { QuotaToastConfig } from "./types.js";

import { formatQuotaRows } from "./format.js";
import { getQuotaProviderShape } from "./provider-metadata.js";
import { findGitWorktreeRoot, getEffectiveConfigRoot } from "./config-file-utils.js";
import {
  loadConfiguredOpenCodeConfig,
  loadConfiguredProviderIds,
} from "./opencode-config-providers.js";
import { resolveQuotaFormatStyle } from "./quota-format-style.js";
import { getPackageVersion } from "./version.js";
import { collectQuotaRenderData } from "./quota-render-data.js";
import { sanitizeQuotaRenderData } from "./display-sanitize.js";
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";
import { buildQuotaExport, createExportProviderContext } from "./quota-export.js";

export interface RunCliShowCommandOptions {
  argv?: string[];
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

type ParsedShowArgs =
  | { ok: true; providerId?: string; help: boolean; json: boolean; threshold?: number }
  | { ok: false; error: string };

const SHOW_USAGE = [
  "Usage:",
  "  npx @slkiser/opencode-quota show [--provider <provider-id>] [--json] [--threshold <pct>]",
  "",
  "Options:",
  "  --provider <provider-id>  Show quota for one provider",
  "  --json                    Machine-readable JSON output (reads from cache)",
  "  --threshold <pct>         With --json, exit 1 if any cached percentage is below <pct>%",
  "                            remaining (exit 2 if no cached percentage can be compared)",
  "  --help, -h                Show help",
].join("\n");

function parseShowArgs(argv: string[]): ParsedShowArgs {
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

  if (threshold !== undefined && !json) {
    return { ok: false, error: "--threshold requires --json." };
  }

  return { ok: true, providerId, help: false, json, threshold };
}

function cloneCliConfig(config: QuotaToastConfig): QuotaToastConfig {
  return {
    ...config,
    enabledProviders: Array.isArray(config.enabledProviders)
      ? [...config.enabledProviders]
      : config.enabledProviders,
    googleModels: [...config.googleModels],
    opencodeGoWindows: [...config.opencodeGoWindows],
    pricingSnapshot: { ...config.pricingSnapshot },
    layout: { ...config.layout },
    showSessionTokens: false,
  };
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

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

async function runCliShowJsonOutput(params: {
  runtime: Awaited<ReturnType<typeof resolveQuotaRuntimeContext>>;
  providerId?: string;
  threshold?: number;
  stdout: Pick<NodeJS.WriteStream, "write">;
}): Promise<number> {
  const { runtime, providerId, threshold, stdout } = params;

  const config = cloneCliConfig(runtime.config);
  if (providerId) {
    config.enabledProviders = [providerId];
  }

  const allProviders = runtime.providers.filter((p) => {
    if (config.enabledProviders === "auto") return true;
    return config.enabledProviders.includes(p.id);
  });

  // Read cached quota through the shared export context so the cache key
  // matches the one the TUI background writer used. Without this, a user with
  // onlyCurrentModel:true would compute a different key and every provider
  // would read back as "unavailable".
  const ctx = createExportProviderContext(runtime);
  const exportData = await buildQuotaExport({
    providers: allProviders,
    ctx,
    ttlMs: config.minIntervalMs,
    fromCache: true,
  });

  writeLine(stdout, JSON.stringify(exportData, null, 2));

  if (threshold !== undefined) {
    const okProviders = Object.values(exportData.providers).filter(
      (p): p is Extract<typeof p, { status: "ok" }> => p.status === "ok",
    );

    if (okProviders.length === 0) {
      // No cached quota to compare against: distinct from "below threshold" (1).
      return 2;
    }

    let hasComparablePercent = false;
    for (const provider of okProviders) {
      const percents = provider.entries
        .map((e) => e.percentRemaining)
        .filter((p): p is number => p !== undefined);
      if (percents.length === 0) continue;
      hasComparablePercent = true;
      const minPercent = Math.min(...percents);
      if (minPercent < threshold) {
        return 1;
      }
    }

    if (!hasComparablePercent) {
      return 2;
    }
  }

  return 0;
}

export async function runCliShowCommand(options: RunCliShowCommandOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(3);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseShowArgs(argv);
  if (!parsed.ok) {
    writeLine(stderr, parsed.error);
    writeLine(stderr, SHOW_USAGE);
    return 1;
  }

  if (parsed.help) {
    writeLine(stdout, SHOW_USAGE);
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

    if (parsed.json) {
      return runCliShowJsonOutput({
        runtime,
        providerId,
        threshold: parsed.threshold,
        stdout,
      });
    }

    const config = cloneCliConfig(runtime.config);
    if (providerId) {
      config.enabledProviders = [providerId];
    }

    const result = await collectQuotaRenderData({
      client: runtime.client,
      config,
      configMeta: runtime.configMeta,
      request: createQuotaRuntimeRequestContext(runtime),
      surfaceExplicitProviderIssues: true,
      formatStyle: resolveQuotaFormatStyle(config.formatStyle),
      providers: runtime.providers,
    });

    if (!result.data) {
      writeLine(stderr, "No quota data available.");
      return 1;
    }

    const data = sanitizeQuotaRenderData(result.data);
    const version = (await getPackageVersion()) ?? "";
    const output = formatQuotaRows({
      version,
      layout: config.layout,
      entries: data.entries,
      errors: data.errors,
      style: resolveQuotaFormatStyle(config.formatStyle),
      percentDisplayMode: config.percentDisplayMode,
    });

    if (!output.trim()) {
      writeLine(stderr, "No quota data available.");
      return 1;
    }

    writeLine(stdout, output);
    return data.entries.length > 0 ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(stderr, `Failed to show quota: ${message}`);
    return 1;
  }
}
