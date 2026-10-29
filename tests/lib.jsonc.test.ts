import { describe, expect, it } from "vite-plus/test";
import { parseJsonOrJsonc, stringifyWithComments } from "../src/lib/jsonc.js";

/**
 * `parseJsonOrJsonc` is the read half of the installer's read-modify-write cycle
 * over the user's own `opencode.jsonc` (`src/lib/init-installer.ts:546`, written
 * back at `:1280` via `writeJsonAtomic`). Anything this parser gets wrong is
 * persisted over the user's file, so the round trip has to be byte-faithful for
 * every part of the document the installer does not intend to change.
 *
 * A hand-rolled trailing-comma pre-pass used to run before `parse`. It tracked
 * `"`/`'` as string delimiters with no notion of comments, so one unpaired quote
 * inside a comment inverted its in-string state for the remainder of the file.
 */
describe("parseJsonOrJsonc", () => {
  it("accepts trailing commas without a pre-pass", () => {
    // comment-json handles these natively; this is why the pre-pass was
    // removable rather than merely fixable.
    expect(parseJsonOrJsonc(`{"a":1,}`, true)).toEqual({ a: 1 });
    expect(parseJsonOrJsonc(`[1,2,]`, true)).toEqual([1, 2]);
    expect(parseJsonOrJsonc(`{"a":{"b":[1,],},}`, true)).toEqual({ a: { b: [1] } });
  });

  it("keeps a string value containing a comma before a closing brace", () => {
    // A single `"` in the comment flipped the pre-pass into "in string" for the
    // rest of the file, so the comma inside this value looked like a trailing
    // comma and was deleted. `*.{ts,}` became `*.{ts}`.
    const parsed = parseJsonOrJsonc(
      `{
  // 27" display
  "glob": "*.{ts,}"
}`,
      true,
    );

    expect(parsed).toEqual({ glob: "*.{ts,}" });
  });

  it("keeps a string value containing a comma before a closing bracket", () => {
    const parsed = parseJsonOrJsonc(
      `{
  // width 80" max
  "pattern": "[a,]"
}`,
      true,
    );

    expect(parsed).toEqual({ pattern: "[a,]" });
  });

  it("preserves comment text ending in a comma across a round trip", () => {
    // The installer rewrites one key and writes the whole document back, so a
    // comment the pre-pass edited was persisted into the user's config. Here the
    // trailing comma of "anthropic, openai," was deleted from their comment.
    const source = `{
  "plugin": ["@slkiser/opencode-quota"],
  "model": "opus"
  // providers we use: anthropic, openai,
}`;

    const parsed = parseJsonOrJsonc(source, true) as Record<string, unknown>;
    parsed.model = "sonnet";

    expect(stringifyWithComments(parsed)).toContain("// providers we use: anthropic, openai,");
  });

  it("preserves a comment mentioning a comma inside an array", () => {
    const source = `{
  "plugin": [
    "@slkiser/opencode-quota"
    // order matters: quota, auth,
  ]
}`;

    const parsed = parseJsonOrJsonc(source, true) as Record<string, unknown>;
    expect(stringifyWithComments(parsed)).toContain("// order matters: quota, auth,");
  });

  it("preserves comments and normalizes trailing commas on write", () => {
    // comment-json drops trailing commas when stringifying; that is its
    // documented behaviour and unrelated to the pre-pass.
    const source = `{
  // keep me
  "plugin": [
    "@slkiser/opencode-quota",
  ],
  /* and me */
  "model": "opus",
}`;

    const parsed = parseJsonOrJsonc(source, true) as Record<string, unknown>;
    parsed.model = "sonnet";
    const written = stringifyWithComments(parsed);

    expect(written).toContain("// keep me");
    expect(written).toContain("/* and me */");
    expect(written).toContain(`"model": "sonnet"`);
    expect(parseJsonOrJsonc(written, true)).toEqual({
      plugin: ["@slkiser/opencode-quota"],
      model: "sonnet",
    });
  });

  it("parses plain JSON unchanged", () => {
    const source = `{"plugin":["@slkiser/opencode-quota"],"model":"opus"}`;
    expect(parseJsonOrJsonc(source, false)).toEqual({
      plugin: ["@slkiser/opencode-quota"],
      model: "opus",
    });
  });

  it("still rejects genuinely malformed content", () => {
    // Removing the pre-pass must not make the parser lenient about real syntax
    // errors: the installer refuses to write when the existing config will not
    // parse (`src/lib/init-installer.ts:558`), and that guard has to keep firing.
    expect(() => parseJsonOrJsonc(`{"a": 1`, true)).toThrow();
    expect(() => parseJsonOrJsonc(`{"a" 1}`, true)).toThrow();
    expect(() => parseJsonOrJsonc(`not json`, true)).toThrow();
    expect(() => parseJsonOrJsonc(``, true)).toThrow();
    // `{,}` used to survive because the pre-pass deleted the comma before
    // handing the text over; rejecting it now is the stricter direction.
    expect(() => parseJsonOrJsonc(`{,}`, true)).toThrow();
  });

  it("preserves an apostrophe in a comment", () => {
    const source = `{
  // don't reorder this
  "model": "opus"
}`;

    const parsed = parseJsonOrJsonc(source, true) as Record<string, unknown>;
    expect(stringifyWithComments(parsed)).toContain("// don't reorder this");
  });
});
