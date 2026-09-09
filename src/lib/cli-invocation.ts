/**
 * Shared helpers for probing local CLI binaries with child_process.
 *
 * Shared bounded execFile execution. The invocation builder preserves Claude's
 * existing Windows shell bridge; Alibaba deliberately does not use that builder.
 */

import { execFile } from "child_process";

import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";

export type CliCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnErrorCode?: number | string;
  errorMessage?: string;
};

export type CliCommandInvocation = {
  file: string;
  args: string[];
  display: string;
};

export const CLI_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;

export function resolveCliBinaryPath(
  binaryPath: string | undefined,
  defaultBinary: string,
): string {
  const trimmed = binaryPath?.trim();
  return trimmed ? trimmed : defaultBinary;
}

function formatCommandDisplayArg(value: string): string {
  const sanitized = sanitizeDisplayText(value);
  return /[\s"]/u.test(sanitized) ? JSON.stringify(sanitized) : sanitized;
}

export function formatCommandDisplay(parts: string[]): string {
  return parts.map(formatCommandDisplayArg).join(" ");
}

function quoteWindowsCmdArg(value: string): string {
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function shouldBridgeCommandThroughWindowsShell(binaryPath: string): boolean {
  const normalized = binaryPath.trim().toLowerCase();
  if (!/[\\/]/u.test(normalized)) {
    return true;
  }

  return /\.(?:cmd|bat)$/u.test(normalized);
}

export function buildCliCommandInvocation(
  binaryPath: string | undefined,
  defaultBinary: string,
  args: string[],
  runtime: { platform?: NodeJS.Platform; comspec?: string } = {},
): CliCommandInvocation {
  const resolvedBinaryPath = resolveCliBinaryPath(binaryPath, defaultBinary);
  const display = formatCommandDisplay([resolvedBinaryPath, ...args]);

  if (
    (runtime.platform ?? process.platform) === "win32" &&
    shouldBridgeCommandThroughWindowsShell(resolvedBinaryPath)
  ) {
    return {
      file: runtime.comspec?.trim() || process.env["ComSpec"]?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", [resolvedBinaryPath, ...args].map(quoteWindowsCmdArg).join(" ")],
      display,
    };
  }

  return {
    file: resolvedBinaryPath,
    args: [...args],
    display,
  };
}

export function isTimedOutCliError(
  error: Error & { code?: number | string; killed?: boolean },
): boolean {
  return (
    error.code === "ETIMEDOUT" ||
    error.killed === true ||
    error.message.toLowerCase().includes("timed out")
  );
}

export function isCliCommandMissing(result: CliCommandResult): boolean {
  if (result.spawnErrorCode === "ENOENT") {
    return true;
  }

  const output = `${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ""}`.toLowerCase();
  return (
    output.includes("command not found") ||
    output.includes("not recognized as an internal or external command") ||
    output.includes("no such file or directory")
  );
}

export function detailFromCliCommandResult(result: CliCommandResult): string | undefined {
  const detail = `${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ""}`.trim();
  return detail ? sanitizeDisplaySnippet(detail, 160) : undefined;
}

export async function runCliCommand(
  invocation: CliCommandInvocation,
  options: { timeoutMs: number; maxBufferBytes?: number; killSignal?: NodeJS.Signals },
): Promise<CliCommandResult> {
  return await new Promise<CliCommandResult>((resolve, reject) => {
    try {
      execFile(
        invocation.file,
        invocation.args,
        {
          encoding: "utf8",
          timeout: options.timeoutMs,
          maxBuffer: options.maxBufferBytes ?? CLI_COMMAND_MAX_BUFFER_BYTES,
          ...(options.killSignal ? { killSignal: options.killSignal } : {}),
        },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          const stdoutText = typeof stdout === "string" ? stdout : stdout.toString("utf8");
          const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");

          if (!error) {
            resolve({
              code: 0,
              stdout: stdoutText,
              stderr: stderrText,
              timedOut: false,
            });
            return;
          }

          const execError = error as Error & { code?: number | string; killed?: boolean };
          resolve({
            code: typeof execError.code === "number" ? execError.code : null,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut: isTimedOutCliError(execError),
            spawnErrorCode: execError.code,
            errorMessage: execError.message,
          });
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}
