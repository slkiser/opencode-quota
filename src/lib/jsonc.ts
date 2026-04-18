import { parse, stringify } from "comment-json";

/**
 * Strip trailing commas from JSON content.
 * Removes commas that appear before closing brackets/braces,
 * while preserving commas inside strings.
 */
export function stripTrailingCommas(content: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";

  while (i < content.length) {
    const char = content[i];

    // Handle string boundaries
    if (char === '"' || char === "'") {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && content[j] === "\\") {
        backslashCount++;
        j--;
      }

      if (backslashCount % 2 === 0) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
        result += char;
        i++;
        continue;
      }
    }

    // If not in a string, check for a trailing comma
    if (!inString && char === ",") {
      let j = i + 1;
      while (j < content.length && /\s/.test(content[j])) {
        j++;
      }
      // If the next non-whitespace character is a closing bracket/brace, skip this comma
      if (j < content.length && (content[j] === "]" || content[j] === "}")) {
        i++;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Parse JSON or JSONC content preserving comments via comment-json.
 */
export function parseJsonOrJsonc(content: string, isJsonc: boolean): unknown {
  const cleaned = stripTrailingCommas(content);
  return parse(cleaned);
}

/**
 * Stringify data back to JSONC while preserving attached comments.
 */
export function stringifyWithComments(data: unknown): string {
  // @ts-ignore - Types for comment-json might complain, but it returns a string
  return stringify(data, null, 2);
}
