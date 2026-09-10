import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeJsonAtomic } from "../src/lib/atomic-json.js";

describe("atomic-json symlinked destinations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-quota-atomic-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes through a symlinked destination instead of replacing the link", async () => {
    const real = join(dir, "dotfiles", "opencode.json");
    const link = join(dir, "opencode.json");
    await writeJsonAtomic(real, { plugin: [] });
    await symlink(real, link);

    await writeJsonAtomic(link, { plugin: ["a"] }, { trailingNewline: true });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf-8"))).toEqual({ plugin: ["a"] });
    expect(await readdir(dir)).toEqual(["dotfiles", "opencode.json"]);
  });

  it("resolves a chain of symlinks down to the real file", async () => {
    const real = join(dir, "real.json");
    const middle = join(dir, "middle.json");
    const link = join(dir, "link.json");
    await writeFile(real, "{}\n", "utf-8");
    await symlink(real, middle);
    await symlink(middle, link);

    await writeJsonAtomic(link, { ok: true });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await lstat(middle)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf-8"))).toEqual({ ok: true });
  });

  it("creates the target of a dangling symlink and keeps the link", async () => {
    const missing = join(dir, "missing.json");
    const link = join(dir, "link.json");
    await symlink(missing, link);

    await writeJsonAtomic(link, { ok: true });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(missing, "utf-8"))).toEqual({ ok: true });
  });

  it("writes a regular file when the destination does not exist", async () => {
    const path = join(dir, "nested", "state.json");

    await writeJsonAtomic(path, { ok: true });

    expect((await lstat(path)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({ ok: true });
  });
});
