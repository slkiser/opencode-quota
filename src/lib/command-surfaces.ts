/**
 * The embedded TUI worker already exposes local dialog commands.
 * Registering the server copies there creates duplicate slash rows.
 * Main-thread hosts, including mini, rely on the server catalog.
 */
export function shouldRegisterServerSlashCommands(params: {
  isMainThread: boolean;
  argv: readonly string[];
}): boolean {
  return params.isMainThread;
}
