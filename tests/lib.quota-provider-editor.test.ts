import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareProviderAdd, writeProviderPlan } from "../src/lib/quota-provider-editor.js";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";
import { runCliProvider } from "../src/lib/cli-provider.js";
const dirs: string[] = [];
function setup(text?: string) {
  const dir = mkdtempSync(join(tmpdir(), "quota-editor-"));
  dirs.push(dir);
  const path = join(dir, "quota-toast.json");
  if (text !== undefined) writeFileSync(path, text, { mode: 0o640 });
  return { dir, path };
}
const definition = {
  id: "custom-local",
  mode: "local-estimate",
  providerId: "fixture",
  windows: [{ id: "day", type: "utc-day", requestLimit: 10 }],
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("guided custom-provider configuration", () => {
  it("adds a remote definition without changing nested unrelated settings", () => {
    const { path } = setup('{"unrelated":{"keep":["[,]", {"x":true}]}}');
    const remote = {
      id: "custom-remote",
      mode: "remote-api",
      url: "https://quota.example.test/status",
      apiKeyEnv: "EXAMPLE_KEY",
      format: "quota-v1",
    };
    const plan = prepareProviderAdd(path, remote);
    writeProviderPlan(plan, plan.digest);
    expect(readFileSync(path, "utf8")).toContain('"unrelated":{"keep":["[,]", {"x":true}]}');
    expect(parseJsonOrJsonc(readFileSync(path, "utf8"), true)).toMatchObject({
      quotaProviders: [expect.objectContaining(remote)],
    });
  });
  it("detects symlink retargeting and changes after an idempotent preview", () => {
    const { dir, path } = setup("{}");
    const other = join(dir, "other.json");
    writeFileSync(other, "{}");
    const link = join(dir, "link.json");
    symlinkSync(path, link);
    const plan = prepareProviderAdd(link, definition);
    rmSync(link);
    symlinkSync(other, link);
    expect(() => writeProviderPlan(plan, plan.digest)).toThrow("Config changed");
    expect(readFileSync(other, "utf8")).toBe("{}");
    const accepted = prepareProviderAdd(path, definition);
    writeProviderPlan(accepted, accepted.digest);
    const noop = prepareProviderAdd(path, definition);
    writeFileSync(path, "{}");
    expect(() => writeProviderPlan(noop, noop.digest)).toThrow("Config changed");
  });

  it.each([
    '{\n // keep secret context\n "apiKey": "PRIVATE_VALUE", // untouched\n "nested": {"quote":"} , \\\"", "x":[1,2,],},\n}',
    '{"apiKey":"PRIVATE_VALUE" /* inline no comma */}',
    '{"quotaProviders": [ /* empty keep */ ], "apiKey":"PRIVATE_VALUE"}',
    '{"quotaProviders": [ {"id":"custom-other","mode":"local-estimate","windows":[{"id":"day","type":"utc-day","requestLimit":2}]} // trailing comment\n], "apiKey":"PRIVATE_VALUE"}',
    '{"quotaProviders": [ {"id":"custom-other","mode":"local-estimate","windows":[{"id":"day","type":"utc-day","requestLimit":2}]}, /* trailing comma */ ], "apiKey":"PRIVATE_VALUE"}',
  ])(
    "preserves JSONC and unrelated secrets while previewing the complete changed field",
    (text) => {
      const { path } = setup(text);
      const plan = prepareProviderAdd(path, definition);
      expect(plan.preview).not.toContain("PRIVATE_VALUE");
      expect(plan.after).toContain(
        '"apiKey":"PRIVATE_VALUE"'.replace(":", text.includes('"apiKey": "') ? ": " : ":"),
      );
      expect(existsSync(`${path}.provider.lock`)).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(text);
      const result = writeProviderPlan(plan, plan.digest);
      expect(readFileSync(result.backup!, "utf8")).toBe(text);
      expect(statSync(result.backup!).mode & 0o777).toBe(0o600);
      expect(statSync(path).mode & 0o777).toBe(0o640);
      expect(parseJsonOrJsonc(readFileSync(path, "utf8"), true)).toMatchObject({
        apiKey: "PRIVATE_VALUE",
        quotaProviders: expect.arrayContaining([expect.objectContaining({ id: "custom-local" })]),
      });
      const again = prepareProviderAdd(path, definition);
      expect(again.changed).toBe(false);
      expect(writeProviderPlan(again, again.digest)).toEqual({});
    },
  );
  it("creates private files only after explicit write and follows existing symlinks", () => {
    const { dir, path } = setup();
    const nested = join(dir, "new", "quota-toast.json");
    const plan = prepareProviderAdd(nested, definition);
    expect(existsSync(dirnameOf(nested))).toBe(false);
    writeProviderPlan(plan, plan.digest);
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    expect(statSync(dirnameOf(nested)).mode & 0o777).toBe(0o700);
    symlinkSync(nested, path);
    chmodSync(nested, 0o640);
    const other = { ...definition, id: "custom-next" };
    const linkPlan = prepareProviderAdd(path, other);
    writeProviderPlan(linkPlan, linkPlan.digest);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(nested, "utf8")).toContain("custom-next");
    expect(statSync(nested).mode & 0o777).toBe(0o640);
  });
  it("rejects stale previews, concurrent edits and held locks without overwriting changes", () => {
    const { path } = setup("{}\n");
    const plan = prepareProviderAdd(path, definition);
    expect(() => writeProviderPlan(plan, "0".repeat(64))).toThrow("Preview changed");
    writeFileSync(path, '{"other":true}');
    expect(() => writeProviderPlan(plan, plan.digest)).toThrow("Config changed");
    expect(readFileSync(path, "utf8")).toBe('{"other":true}');
    const next = prepareProviderAdd(path, definition);
    writeFileSync(`${path}.provider.lock`, "held");
    expect(() => writeProviderPlan(next, next.digest)).toThrow();
    expect(readFileSync(`${path}.provider.lock`, "utf8")).toBe("held");
  });
  it("rolls back precommit failures and keeps a byte-exact backup for explicit recovery", () => {
    const original = '{// preserve\n "unrelated": 42\n}\n';
    const { dir, path } = setup(original);
    const plan = prepareProviderAdd(path, definition);
    expect(() =>
      writeProviderPlan(plan, plan.digest, () => {
        throw new Error("write interrupted");
      }),
    ).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(dir)).toEqual(["quota-toast.json"]);
    expect(() =>
      writeProviderPlan(plan, plan.digest, () => writeFileSync(path, '{"concurrent":true}')),
    ).toThrow("Config changed");
    expect(readFileSync(path, "utf8")).toBe('{"concurrent":true}');
    expect(readdirSync(dir)).toEqual(["quota-toast.json"]);
    const accepted = prepareProviderAdd(path, definition);
    const { backup } = writeProviderPlan(accepted, accepted.digest);
    writeFileSync(path, readFileSync(backup!));
    expect(readFileSync(path, "utf8")).toBe('{"concurrent":true}');
  });
  it("rejects invalid/ambiguous input and conflicting definitions", () => {
    for (const text of [
      '{"quotaProviders":[],"quotaProviders":[]}',
      "[]",
      '{"quotaProviders":{}}',
      "{bad}",
    ]) {
      const { path } = setup(text);
      expect(() => prepareProviderAdd(path, definition)).toThrow();
    }
    const { path } = setup();
    expect(() => prepareProviderAdd(path, { ...definition, apiKey: "SECRET" })).toThrow();
    const p = prepareProviderAdd(path, definition);
    writeProviderPlan(p, p.digest);
    expect(() => prepareProviderAdd(path, { ...definition, providerId: "other" })).toThrow(
      "already configured",
    );
    const dangling = join(dirs[dirs.length - 1], "dangling");
    symlinkSync("/missing/quota-config", dangling);
    expect(() => prepareProviderAdd(dangling, definition)).toThrow();
  });
  it("CLI requires a reviewed digest and redacts malformed contents without network calls", async () => {
    const { dir } = setup();
    vi.stubEnv("XDG_CONFIG_HOME", join(dir, "config"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    const input = join(dir, "input.json");
    writeFileSync(input, JSON.stringify(definition));
    expect(await runCliProvider(["add", input])).toBe(0);
    const output = log.mock.calls.flat().join("\n");
    const digest = output.match(/Preview SHA256: ([a-f0-9]{64})/)![1];
    const target = join(dir, "config", "opencode", "opencode-quota", "quota-toast.json");
    expect(existsSync(target)).toBe(false);
    expect(await runCliProvider(["add", input, "--write"])).toBe(1);
    expect(await runCliProvider(["add", input, "--write", "--expect", digest])).toBe(0);
    expect(await runCliProvider(["status"])).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    writeFileSync(input, '{"secret":"DO_NOT_PRINT"');
    expect(await runCliProvider(["add", input])).toBe(1);
    expect(error.mock.calls.flat().join(" ")).not.toContain("DO_NOT_PRINT");
  });
});
function dirnameOf(path: string) {
  return path.slice(0, path.lastIndexOf("/"));
}
