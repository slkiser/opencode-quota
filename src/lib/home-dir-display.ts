import type { ReportBlock, ReportDocument } from "./report-document.js";

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

/** A Windows device-path prefix before the drive: `\\?\C:\…`, `\\.\C:\…`, JSON-escaped too. */
const DEVICE_PREFIX = "(?:[/\\\\]{2,4}[?.][/\\\\]{1,2})?";

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

/**
 * The home dir as a pattern. Spaces in it match any run of whitespace. A Windows home
 * (C:\Users\Alice) also matches in any letter case, with "/", "\" or JSON's escaped "\\"
 * between its parts, and after a device prefix, as programs and JSON print it:
 * c:/users/alice, "C:\\Users\\Alice", \\?\C:\Users\Alice.
 */
function homeDirPattern(home: string): RegExp {
  const literal = (part: string) => escapeRegExp(part).replace(/\s+/gu, "\\s+");
  const windows = /^[A-Za-z]:/u.test(home) || home.includes("\\");
  const body = windows
    ? DEVICE_PREFIX +
      home
        .split(/[/\\]+/u)
        .map(literal)
        .join("(?:\\\\\\\\|[/\\\\])")
    : literal(home);
  return new RegExp(`${HOME_DIR_START}${body}${HOME_DIR_END}`, windows ? "giu" : "gu");
}

/**
 * Shows the home dir as "~" so pasted reports do not reveal the computer's user name:
 * "/Users/alice/.config" -> "~/.config", "/Users/alice" -> "~". Only whole home-dir
 * matches change; "/Users/alicesmith" stays as it is. Display only, never for reading files.
 */
export function replaceHomeDirWithTilde(text: string, homeDir: string): string {
  const home = normalizeHomeDir(homeDir);
  return home ? text.replace(homeDirPattern(home), "~") : text;
}

// Optional fields are only set when the input has them. An optional field set to `undefined`
// is not a JSON value, and OpenCode rejects a command result that contains one.
function replaceHomeDirInBlock(block: ReportBlock, homeDir: string): ReportBlock {
  const tilde = (text: string) => replaceHomeDirWithTilde(text, homeDir);

  switch (block.kind) {
    case "lines":
      return { ...block, lines: block.lines.map(tilde) };
    case "kv":
      return {
        ...block,
        rows: block.rows.map((row) => ({
          ...row,
          key: tilde(row.key),
          ...(row.value !== undefined && { value: tilde(row.value) }),
        })),
      };
  }
}

/** The same document with the home dir shown as "~" in every piece of text it displays. */
export function replaceHomeDirWithTildeInDocument(
  document: ReportDocument,
  homeDir: string,
): ReportDocument {
  const tilde = (text: string) => replaceHomeDirWithTilde(text, homeDir);

  return {
    ...document,
    ...(document.heading !== undefined && { heading: tilde(document.heading) }),
    sections: document.sections.map((section) => ({
      ...section,
      ...(section.title !== undefined && { title: tilde(section.title) }),
      blocks: section.blocks.map((block) => replaceHomeDirInBlock(block, homeDir)),
    })),
  };
}
