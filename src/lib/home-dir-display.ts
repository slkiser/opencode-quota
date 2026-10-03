/**
 * Characters that may end a home-dir match: a path separator (the path goes on below home),
 * whitespace, or punctuation the reports put around paths. Anything else, e.g. the "s" in
 * "/Users/alicesmith" or the "." in "/Users/alice.old", means a different folder.
 *
 * Whitespace ends a match on purpose, so prose such as "not found at /Users/alice is missing"
 * hides the user name. The known cost: a folder whose name continues after a space, e.g.
 * "/Users/alice backup/project", shows as "~ backup/project".
 */
const HOME_DIR_END = "(?=$|[/\\\\\\s|,;:)\\]\"'`])";

/**
 * What may come right before a home-dir match: the start of the text, whitespace, or a
 * delimiter the reports put before paths ("path=", "(", a quote, "a | b", "key:"). Anything
 * else, e.g. "/mnt/备份/Users/alice", means the match is deeper inside another path.
 */
const HOME_DIR_START = "(?<=^|[\\s\"'`=(\\[:,|])";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The home dir without trailing separators, or null when it is empty or a filesystem root
 * ("/", "C:\"), which would turn every path into "~".
 */
function normalizeHomeDir(homeDir: string): string | null {
  const trimmed = homeDir.replace(/[/\\]+$/u, "");
  if (trimmed === "" || /^[A-Za-z]:$/u.test(trimmed)) return null;
  return trimmed;
}

function replaceWholeHomeDir(text: string, home: string): string {
  const pattern = new RegExp(`${HOME_DIR_START}${escapeRegExp(home)}${HOME_DIR_END}`, "gu");
  return text.replace(pattern, "~");
}

/**
 * Shows the home dir as "~" so pasted reports do not reveal the computer's user name:
 * "/Users/alice/.config" -> "~/.config", "/Users/alice" -> "~". Only whole home-dir
 * matches change; "/Users/alicesmith" stays as it is. Display only, never for reading files.
 */
export function replaceHomeDirWithTilde(text: string, homeDir: string): string {
  const home = normalizeHomeDir(homeDir);
  if (!home) return text;
  // A JSON-quoted Windows path doubles its backslashes, e.g. a quoted command in
  // checked_commands: "C:\\Users\\Alice Smith\\.local\\bin\\claude" -> "~\\.local\\bin\\claude".
  const jsonEscapedHome = home.replace(/\\/gu, "\\\\");
  const withoutEscapedHome =
    jsonEscapedHome === home ? text : replaceWholeHomeDir(text, jsonEscapedHome);
  return replaceWholeHomeDir(withoutEscapedHome, home);
}
