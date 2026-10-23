/**
 * Credential redaction for any provider text the store keeps or sends: error details, debug
 * details and logs. Provider errors can echo a request (an Authorization header, a key in the
 * query string, a token in a JSON body), so every such text passes here before it is cut to
 * length, saved or shown. `publicDetail` also hides the home dir, email addresses and account
 * ids, for the error and debug details the store keeps. /quota_status shows only structured
 * values and passes them through `publicDetail` as a second filter.
 *
 * The agent tools use the same key shapes: `looksSecret` refuses a definition or setting that
 * holds one, and `secretValuesRedactor` cleans their answers.
 */
import { homedir } from "node:os";
import { sanitizeDisplayText, sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";
import { replaceHomeDirWithTilde } from "../lib/home-dir-display.js";
import { isRecord } from "../lib/json-guards.js";

export const REDACTED = "[redacted]";
const PRIVATE_ID = "[id]";
const EMAIL_ADDRESS = "[email]";

/** Words that make a field name secret wherever they stand in it: "session_id", "x-api-key". */
const SECRET_WORDS = new Set([
  "token",
  "key",
  "apikey",
  "secret",
  "password",
  "passwd",
  "pwd",
  "cookie",
  "cookies",
  "session",
  "sessionid",
  "authorization",
  "credential",
  "credentials",
  "signature",
  "sig",
  "jwt",
  "bearer",
]);

/** Last words of a debug key that make it a fact about a secret: "api_key_source". */
const FACT_WORDS = new Set([
  "source",
  "env",
  "present",
  "configured",
  "set",
  "kind",
  "type",
  "status",
  "expires",
  "expiry",
  "age",
  "state",
  "path",
  "paths",
  "file",
  "name",
  "count",
  "diagnostics",
]);

/** A field name's words, split on anything but letters and digits and on camelCase. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/**
 * True when a word of a field name is a secret word: "access_token", "apiKey", "XSRFToken",
 * "Set-Cookie", "session_id".
 */
function namesSecret(name: string): boolean {
  return nameWords(name).some((word) => SECRET_WORDS.has(word));
}

/**
 * A field value: a JSON array (a "]" inside its strings included), quoted to its closing quote
 * (escaped quotes and spaces included; also with escaped quotes around it, as in JSON inside
 * JSON), or one unquoted word.
 */
const VALUE = String.raw`(?:\[(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\]"'])*\]?|\\"(?:[^\\]|\\(?!"))*(?:\\")?|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s"'&,;}]+)`;

/** Between a name and its value: `=`, `: `, JSON's `":` and escaped JSON's `\":`. */
const SEPARATOR = String.raw`(\\?["']?\s*[:=]\s*)`;

/** `name: value`, `name=value`, `"name":"value"` (also `\"name\":\"value\"`). */
const NAMED_VALUE = String.raw`\b([A-Za-z_][\w-]{0,63})${SEPARATOR}${VALUE}`;

/** The value of every pair whose name holds a secret; other values are searched as well. */
function redactNamedValues(text: string): string {
  const pattern = new RegExp(NAMED_VALUE, "gu");
  let result = "";
  let copied = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [whole, name = "", separator = ""] = match;
    const valueAt = match.index + name.length + separator.length;
    if (holdsSecret(name)) {
      result += `${text.slice(copied, valueAt)}${REDACTED}`;
      copied = match.index + whole.length;
    } else {
      // The value may hold pairs of its own: {"error":"bad api_key=abc"}.
      pattern.lastIndex = valueAt;
    }
  }
  return result + text.slice(copied);
}

/**
 * Cookie, Set-Cookie and Authorization headers: the whole value, to the end of the line or the
 * next " | " joiner. The JSON forms ("cookie": "a=1") are named values.
 */
const HEADER_VALUE =
  /\b((?:set-)?cookie|(?:proxy-)?authorization)(\s*[:=]\s*)(?:(?! \| )[^\r\n])*/giu;

/** A credential after an auth scheme, outside a header too: "Bearer abc", "Basic abc". */
const SCHEME_CREDENTIAL = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu;

/**
 * Known key formats, found anywhere in a text; each is replaced whole. Names and labels can take
 * a `nameLike` format too ("pk-gateway-quota", "xai-production", "monkeyJsonPathsAndMore").
 */
const KEY_FORMATS: ReadonlyArray<{ pattern: RegExp; nameLike?: true }> = [
  { pattern: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/gu, nameLike: true }, // OpenAI, Stripe
  { pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/gu }, // GitHub
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/gu }, // Google API key
  { pattern: /\bxai-[A-Za-z0-9]{10,}/gu, nameLike: true }, // xAI
  { pattern: /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/gu, nameLike: true }, // JWT
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/gu }, // OpenAI, Anthropic, OpenRouter, DeepSeek
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/gu }, // JWT, 3 parts
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu }, // Slack
  { pattern: /\bAKIA[0-9A-Z]{16}\b/gu }, // AWS
  { pattern: /\bya29\.[0-9A-Za-z_-]{20,}/gu }, // Google OAuth access token
  { pattern: /\b1\/\/[0-9A-Za-z_-]{20,}/gu }, // Google OAuth refresh token
  // A PEM private key, to its end line or, cut short, to the end of the text.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu },
];

/** True when a match holds a run of 10+ letters and digits that looks random: a key, not a name. */
function looksLikeKey(match: string): boolean {
  return (match.match(/[A-Za-z0-9]{10,}/gu) ?? []).some(looksRandom);
}

/**
 * `text` with each key shape the agent tools know replaced. Their inputs and answers hold names
 * and row labels ("Basic requests"), so an auth scheme's credential and a `nameLike` format count
 * only when they look like a key. "Bearer" hides everything up to the next space.
 */
function hideAgentKeyShapes(text: string): string {
  let result = text.replace(/\bbearer\s+\S{8,}/giu, REDACTED);
  result = result.replace(SCHEME_CREDENTIAL, (match, scheme: string) =>
    looksLikeKey(match) ? `${scheme} ${REDACTED}` : match,
  );
  for (const { pattern, nameLike } of KEY_FORMATS) {
    result = result.replace(pattern, (match) =>
      nameLike && !looksLikeKey(match) ? match : REDACTED,
    );
  }
  return result;
}

/**
 * One part of a name or model id: a word, also capitalised, camel-cased or with a number after
 * it ("Coder", "DeepSeek", "Qwen3", "FP8"), a number, or up to 4 letters and digits ("A35B").
 */
const NAME_PART =
  /^(?:[a-z]{1,20}|[A-Z]{1,20}\d{0,4}|(?:[A-Z]{1,6}|[A-Z]?[a-z]{2,20}){1,3}\d{0,4}|\d{1,14}|[A-Za-z0-9]{1,4})$/u;

/**
 * A long run of letters, digits, `_` and `-` is a token or session id, unless it is words and
 * numbers joined by separators: a model id ("Qwen3-Coder-480B-A35B-Instruct-FP8") or a name
 * ("custom_production-gateway-us_check").
 */
function hideOpaqueRun(run: string): string {
  const parts = run.split(/[-_]+/u).filter(Boolean);
  const wordsOnly = parts.length >= 2 && parts.every((part) => NAME_PART.test(part));
  return wordsOnly ? run : REDACTED;
}

/**
 * `text` with credential-looking parts replaced by "[redacted]": headers and auth schemes first
 * (the scheme word stays), then named values, then every key format and long opaque runs.
 */
function redactSecrets(text: string): string {
  let result = text
    .replace(HEADER_VALUE, `$1$2${REDACTED}`)
    .replace(SCHEME_CREDENTIAL, `$1 ${REDACTED}`);
  result = redactNamedValues(result);
  for (const { pattern } of KEY_FORMATS) result = result.replace(pattern, REDACTED);
  return result.replace(/[A-Za-z0-9_-]{32,}/gu, hideOpaqueRun);
}

/**
 * True when a run of letters and digits switches between letters, digits and case so often
 * that its pieces average under 3 characters: a random token, not words. A camelCase name such
 * as "AvailableBalanceUSD2024Total" splits into Available|Balance|USD|2024|Total and passes; a
 * hex or base62 key splits into pieces of 1-2 characters.
 */
function looksRandom(run: string): boolean {
  if (!/[0-9]/u.test(run) || !/[A-Za-z]/u.test(run)) return false;
  const pieces = run.match(/[0-9]+|[A-Z]+(?![a-z])|[A-Z]?[a-z]+/gu) ?? [];
  return run.length / pieces.length < 3;
}

/**
 * True when a text holds something shaped like a key: a known key shape, a random run of
 * letters and digits, or (outside a name: an id, model name, URL or JSON path) any run of 24+
 * of them. Any other character ends a run, so model names such as
 * "Qwen3-Coder-480B-A35B-Instruct-2507", UUIDs and version strings pass.
 */
export function looksSecret(text: string, { isName }: { isName: boolean }): boolean {
  if (hideAgentKeyShapes(text) !== text) return true;
  return (text.match(/[A-Za-z0-9]{20,}/gu) ?? []).some(
    (run) => looksRandom(run) || (!isName && run.length >= 24),
  );
}

/** Secrets this long are replaced anywhere; shorter ones only as a whole token, so no word is cut. */
const LONG_SECRET_LENGTH = 8;

/**
 * Replaces, in one text, each of `secrets` and each key shape the agent tools know. A secret under
 * LONG_SECRET_LENGTH counts only as a whole token (letters, digits, `_` and `-`).
 */
export function secretValuesRedactor(secrets: readonly string[]): (text: string) => string {
  // Longest first, so a secret that contains another is replaced whole.
  const patterns = [...new Set(secrets)]
    .sort((a, b) => b.length - a.length)
    .map((secret) => {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      const wholeToken = secret.length < LONG_SECRET_LENGTH;
      return new RegExp(wholeToken ? `(?<![\\w-])${escaped}(?![\\w-])` : escaped, "g");
    });
  return (text) =>
    hideAgentKeyShapes(
      patterns.reduce((result, pattern) => result.replace(pattern, REDACTED), text),
    );
}

/** A copy of a JSON value with `redact` applied to every string in it, property names too. */
export function redactJson(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [redact(name), redactJson(item, redact)]),
    );
  }
  return value;
}

/**
 * The text as a screen shows it, before any pattern looks at it: JSON's `\u0049` escapes
 * decoded and control characters removed (an escape inside a name or home dir would hide it
 * from the patterns). Line breaks stay.
 */
function visibleText(text: string): string {
  const decoded = text.replace(/(?<!\\)\\u([0-9A-Fa-f]{4})/gu, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return sanitizeDisplayText(decoded);
}

/** One safe line: control characters removed, credentials redacted, then cut to `maxLength`. */
export function safeDetail(text: string, maxLength: number): string {
  return redactSecrets(sanitizeSingleLineDisplayText(visibleText(text))).slice(0, maxLength);
}

/** An error's message (or any thrown value) as one safe line of at most 120 characters. */
export function safeErrorText(error: unknown): string {
  return safeDetail(error instanceof Error ? error.message : String(error), 120);
}

/**
 * True when a debug key's value is a secret: the key names one, and its last word does not
 * name a fact about it ("api_key_source", "token_expires_at", "apiKeyEnv").
 */
function holdsSecret(key: string): boolean {
  const words = nameWords(key);
  const last = words.at(-1) === "at" ? words.at(-2) : words.at(-1);
  return namesSecret(key) && !FACT_WORDS.has(last ?? "");
}

/** Whose data a field is about: a "<word> id" field holds a private identity. */
const PRIVATE_ID_WORDS = ["account", "team", "org", "organization", "user", "session"];

/** Checked in order; each replaces what it matches. */
const PRIVATE_ID_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // account_id=abc, "teamId": "t_1", "user_ids": ["a", "b"], \"org_id\":\"o_1\"
  [
    new RegExp(
      `\\b((?:[A-Za-z0-9]+[_-])*(?:${PRIVATE_ID_WORDS.join("|")})[_-]?ids?)${SEPARATOR}${VALUE}`,
      "giu",
    ),
    `$1$2${PRIVATE_ID}`,
  ],
  // alice@example.com, alice%40example.com
  [/[\w.%+-]+(?:@|%40)[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/giu, EMAIL_ADDRESS],
];

/** True when a field name ends in an account, team, org, user or session id: "teamId". */
function namesPrivateId(name: string): boolean {
  const words = nameWords(name);
  const last = words.at(-1) ?? "";
  if (last === "id" || last === "ids") return PRIVATE_ID_WORDS.includes(words.at(-2) ?? "");
  return PRIVATE_ID_WORDS.some((word) => last === `${word}id` || last === `${word}ids`);
}

/**
 * Text a public issue may show: control characters removed first, then the home dir as "~"
 * (found before spaces are joined), then one line with credentials as "[redacted]", email
 * addresses as "[email]", and account, team, org, user and session ids as "[id]". It is cut to
 * `maxLength` last, so a cut never leaves part of a hidden value.
 */
export function publicDetail(text: string, maxLength: number, homeDir = homedir()): string {
  let result = sanitizeSingleLineDisplayText(replaceHomeDirWithTilde(visibleText(text), homeDir));
  for (const [pattern, replacement] of PRIVATE_ID_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return redactSecrets(result).slice(0, maxLength);
}

/** A detail's value as `publicDetail` shows it; all hidden when its key holds a secret or an id. */
export function publicDebugValue(
  key: string,
  value: string,
  maxLength: number,
  homeDir = homedir(),
): string {
  if (namesPrivateId(key)) return PRIVATE_ID;
  if (holdsSecret(key)) return REDACTED;
  return publicDetail(value, maxLength, homeDir);
}
