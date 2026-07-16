/**
 * The embedded and mini TUI already expose local dialog commands.
 * Registering the server copies there creates duplicate slash rows.
 */
export function shouldRegisterServerSlashCommands(params: {
  isMainThread: boolean;
  argv: readonly string[];
}): boolean {
  if (!params.isMainThread) return false;
  return !params.argv.some((arg) => arg === "--mini" || arg.startsWith("--mini="));
}
