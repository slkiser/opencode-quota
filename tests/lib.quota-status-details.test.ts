/**
 * The debug keys providers write (read from their source) against the rules /quota_status has
 * for them in `src/lib/quota-status.ts`: every key a provider writes has a rule in its section,
 * and every rule is for a key some provider writes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { QUOTA_PROVIDER_CATALOG } from "../src/lib/provider-metadata.js";
import { debugDetailRules } from "../src/lib/quota-status.js";

const SRC = new URL("../src/", import.meta.url);
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, SRC)), "utf8");

/** Each provider file, by the ids of the providers it makes. */
const PROVIDER_FILES: Readonly<Record<string, readonly string[]>> = {
  "alibaba.ts": ["alibaba-coding-plan", "alibaba-token-plan"],
  "anthropic.ts": ["anthropic"],
  "copilot.ts": ["copilot"],
  "cursor.ts": ["cursor"],
  "deepseek.ts": ["deepseek"],
  "glm-coding-plan.ts": ["zai", "zhipu"],
  "google-agy.ts": ["google-agy"],
  "google-gemini-cli.ts": ["google-gemini-cli"],
  "kimi-code.ts": ["kimi-code-plan-global", "kimi-code-plan-cn"],
  "mimo.ts": ["xiaomi"],
  "minimax-coding-plan.ts": ["minimax-coding-plan", "minimax-china-coding-plan"],
  "ollama-cloud.ts": ["ollama-cloud"],
  "openai.ts": ["openai"],
  "opencode-go.ts": ["opencode-go"],
  "opencode-zen.ts": ["opencode"],
  "openrouter.ts": ["openrouter"],
  "quota-providers.ts": ["quota-providers"],
  "xai.ts": ["xai"],
};
/** Provider files of shared helpers: their keys count for the providers that call them. */
const HELPER_FILES = ["result-helpers.ts", "google-oauth-provider.ts"];
/** Files that write the details any section may have (setup, errors, dropped rows). */
const SETUP_FILES = ["core/rows.ts", "core/validate.ts", "lib/quota-dialog-commands.ts"];
/** A failed login's own words: /quota_status skips them and shows their `error_kind`. */
const SKIPPED_KEYS = ["error"];
/** Keys written with a number or a custom provider's id in them, by their shape. */
const KEY_SHAPES: Readonly<Record<string, RegExp>> = {
  "live_error_${…}": /^live_error_\$\{…\}$/u,
  "custom_${…}_check": /^custom_\$\{…\}_check$/u,
};

/**
 * The top-level property names of each `statusDetailsFromRecord({ … })` call: the record is cut
 * at its own commas (not those in strings or nested brackets), and each part's name is read.
 */
function recordKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(/statusDetailsFromRecord\(\{/gu)) {
    const parts = [""];
    let depth = 1;
    let quote = "";
    for (let index = match.index + match[0].length; depth > 0; index += 1) {
      const char = text[index] ?? "";
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if ("{([".includes(char)) {
        depth += 1;
      } else if ("})]".includes(char)) {
        depth -= 1;
      } else if (char === "," && depth === 1) {
        parts.push("");
        continue;
      }
      if (depth === 1) parts[parts.length - 1] += char;
    }
    for (const part of parts) {
      const name = /^\s*(?:"([^"]+)"|([a-z_][a-z0-9_]*)):/u.exec(part);
      if (name) keys.push(name[1] ?? name[2] ?? "");
    }
  }
  return keys;
}

/**
 * The debug keys a file writes: `{ key: "…", value }` details, `detail("…", …)` and the
 * properties of `statusDetailsFromRecord` records, on one line or spread over several. A key
 * built in a template keeps its text with each `${…}` part as `${…}`.
 */
function writtenKeys(text: string): string[] {
  const computed = [...text.matchAll(/\{\s*key: (?!["`])([^,]+),\s*value:/gu)];
  expect(
    computed.map((match) => match[1]),
    "a debug key is a literal or a template",
  ).toEqual([]);
  return [
    ...[...text.matchAll(/\{\s*key: "([^"]+)",\s*value:/gu)].map((match) => match[1] ?? ""),
    ...[...text.matchAll(/\{\s*key: `([^`]+)`,\s*value:/gu)].map((match) =>
      (match[1] ?? "").replace(/\$\{[^}]*\}/gu, "${…}"),
    ),
    ...[...text.matchAll(/\bdetail\(\s*"([^"]+)"/gu)].map((match) => match[1] ?? ""),
    ...recordKeys(text),
  ];
}

/** Each exported helper's keys, by function name. */
const helperKeys = new Map<string, string[]>();
for (const file of HELPER_FILES) {
  const text = source(`providers/${file}`);
  const starts = [...text.matchAll(/^export (?:async )?function (\w+)/gmu)];
  for (const [index, start] of starts.entries()) {
    const body = text.slice(start.index, starts[index + 1]?.index ?? text.length);
    const keys = writtenKeys(body);
    if (keys.length > 0) helperKeys.set(start[1] ?? "", keys);
  }
}

/** A file's own keys and those of the helpers it calls. */
function fileKeys(text: string): Set<string> {
  const keys = new Set(writtenKeys(text));
  for (const [name, helper] of helperKeys) {
    if (!new RegExp(`\\b${name}\\(`, "u").test(text)) continue;
    for (const key of helper) keys.add(key);
  }
  return keys;
}

const writtenByProvider = new Map<string, Set<string>>();
for (const [file, ids] of Object.entries(PROVIDER_FILES)) {
  const keys = fileKeys(source(`providers/${file}`));
  for (const id of ids) writtenByProvider.set(id, keys);
}
const writtenBySetup = new Set(SETUP_FILES.flatMap((file) => [...fileKeys(source(file))]));

function shapeOf(key: string): string | undefined {
  return Object.keys(KEY_SHAPES).find((shape) => KEY_SHAPES[shape]?.test(key));
}

describe("/quota_status debug detail rules", () => {
  it("knows the file of every provider and of every provider file", () => {
    expect(Object.values(PROVIDER_FILES).flat().sort()).toEqual(
      Object.keys(QUOTA_PROVIDER_CATALOG).sort(),
    );
    const providerDir = fileURLToPath(new URL("providers/", SRC));
    const writers = readdirSync(providerDir).filter(
      (file) => !HELPER_FILES.includes(file) && fileKeys(source(`providers/${file}`)).size > 0,
    );
    expect(writers.filter((file) => !Object.hasOwn(PROVIDER_FILES, file))).toEqual([]);
  });

  it.each(Object.entries(PROVIDER_FILES))("has a rule for every key %s writes", ([, ids]) => {
    // A file can hold more than one provider (`alibaba.ts`), and each of them rules only the
    // keys it writes, so the file's keys are ruled by the ids that file makes between them.
    const written = writtenByProvider.get(ids[0] ?? "") ?? new Set<string>();
    const unruled = [...written].filter(
      (key) =>
        !ids.some((id) => {
          const { shared, own } = debugDetailRules(id);
          return Object.hasOwn(own, key) || Object.hasOwn(shared, key);
        }) && !shapeOf(key),
    );
    expect(unruled).toEqual([]);
  });

  it("has a shared rule for every setup key", () => {
    const shared = new Set(
      Object.keys(QUOTA_PROVIDER_CATALOG).flatMap((id) => Object.keys(debugDetailRules(id).shared)),
    );
    const unruled = [...writtenBySetup].filter(
      (key) => !shared.has(key) && !SKIPPED_KEYS.includes(key),
    );
    expect(unruled).toEqual([]);
  });

  it.each([...writtenByProvider.keys()])("has a rule only for keys %s writes", (id) => {
    const written = writtenByProvider.get(id) ?? new Set();
    expect(Object.keys(debugDetailRules(id).own).filter((key) => !written.has(key))).toEqual([]);
  });

  it("has a shared rule only for keys some provider or setup check writes", () => {
    const written = new Set([
      ...writtenBySetup,
      ...[...writtenByProvider.values()].flatMap((keys) => [...keys]),
    ]);
    const shared = new Set(
      Object.keys(QUOTA_PROVIDER_CATALOG).flatMap((id) => Object.keys(debugDetailRules(id).shared)),
    );
    expect([...shared].filter((key) => !written.has(key))).toEqual([]);
  });

  it("finds each key shape some file writes", () => {
    const written = [
      ...writtenBySetup,
      ...[...writtenByProvider.values()].flatMap((keys) => [...keys]),
    ];
    for (const shape of Object.keys(KEY_SHAPES)) expect(written).toContain(shape);
  });
});
