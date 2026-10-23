import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  configWriteTargetsEqual,
  MAX_CONFIG_SYMLINK_HOPS,
  NEW_CONFIG_FILE_MODE,
  resolveConfigWriteTarget,
  writeResolvedConfigText,
} from "../src/lib/config-write-target.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-config-write-target-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("resolveConfigWriteTarget", () => {
  it("treats a missing non-symlink path as a creatable regular file", async () => {
    const dir = makeTempDir();
    const path = join(dir, "nested", "opencode.json");
    await expect(resolveConfigWriteTarget(path)).resolves.toEqual({
      configuredPath: path,
      writePath: path,
      hops: [],
      terminalExisted: false,
    });
  });

  it("canonicalizes an existing regular file under a symlinked directory parent", async () => {
    const root = makeTempDir();
    const realParent = join(root, "actual");
    const aliasParent = join(root, "alias");
    const realFile = join(realParent, "opencode.json");
    mkdirSync(realParent);
    writeFileSync(realFile, "{}\n");
    symlinkSync(realParent, aliasParent, "dir");
    const configured = join(aliasParent, "opencode.json");

    await expect(resolveConfigWriteTarget(configured)).resolves.toEqual({
      configuredPath: configured,
      writePath: realpathSync(realFile),
      hops: [],
      terminalExisted: true,
    });
  });

  it("resolves a relative hop from a symlinked directory parent using kernel semantics", async () => {
    const root = makeTempDir();
    const realParent = join(root, "actual", "place");
    const aliasParent = join(root, "elsewhere", "alias");
    const realFile = join(root, "actual", "secrets", "opencode.json");
    const wrongFile = join(root, "elsewhere", "secrets", "opencode.json");
    mkdirSync(realParent, { recursive: true });
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    mkdirSync(join(root, "actual", "secrets"), { recursive: true });
    mkdirSync(join(root, "elsewhere", "secrets"), { recursive: true });
    writeFileSync(realFile, '{"plugin":[]}\n');
    writeFileSync(wrongFile, '{"plugin":["wrong"]}\n');
    symlinkSync("../secrets/opencode.json", join(realParent, "opencode.json"));
    symlinkSync(realParent, aliasParent);

    const configured = join(aliasParent, "opencode.json");
    // Windows stores backslashes even when symlinkSync receives forward slashes.
    const linkText = readlinkSync(configured);
    const target = await resolveConfigWriteTarget(configured);
    expect(target.writePath).toBe(realpathSync(realFile));
    expect(target.hops).toEqual([{ path: configured, linkText }]);
    expect(target.terminalExisted).toBe(true);

    await writeResolvedConfigText(target, '{"plugin":["ok"]}\n');
    expect(readFileSync(realFile, "utf8")).toBe('{"plugin":["ok"]}\n');
    expect(readFileSync(wrongFile, "utf8")).toBe('{"plugin":["wrong"]}\n');
    expect(lstatSync(configured).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configured)).toBe(linkText);
  });

  it("resolves a relative symlink to its regular-file target", async () => {
    const dir = makeTempDir();
    const real = join(dir, "dotfiles", "opencode.json");
    const link = join(dir, "config", "opencode.json");
    mkdirSync(join(dir, "dotfiles"), { recursive: true });
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(real, '{\n  "plugin": []\n}\n');
    symlinkSync("../dotfiles/opencode.json", link);
    const linkText = readlinkSync(link);

    await expect(resolveConfigWriteTarget(link)).resolves.toEqual({
      configuredPath: link,
      writePath: realpathSync(real),
      hops: [{ path: link, linkText }],
      terminalExisted: true,
    });
  });

  it("resolves an absolute symlink and a valid chain", async () => {
    const dir = makeTempDir();
    const real = join(dir, "real.json");
    const middle = join(dir, "middle.json");
    const link = join(dir, "link.json");
    writeFileSync(real, "{}\n");
    symlinkSync(real, middle);
    symlinkSync(middle, link);

    await expect(resolveConfigWriteTarget(link)).resolves.toEqual({
      configuredPath: link,
      writePath: realpathSync(real),
      hops: [
        { path: link, linkText: middle },
        { path: middle, linkText: real },
      ],
      terminalExisted: true,
    });
  });

  it.each([
    {
      reason: "dangling",
      link: (dir: string) => symlinkSync(join(dir, "missing.json"), join(dir, "link.json")),
    },
    {
      reason: "loop",
      link: (dir: string) => {
        symlinkSync(join(dir, "other.json"), join(dir, "link.json"));
        symlinkSync(join(dir, "link.json"), join(dir, "other.json"));
      },
    },
    {
      reason: "non-regular",
      link: (dir: string) => {
        mkdirSync(join(dir, "target-dir"));
        symlinkSync(join(dir, "target-dir"), join(dir, "link.json"));
      },
    },
  ])("fails closed on a $reason symlink", async ({ reason, link }) => {
    const dir = makeTempDir();
    link(dir);
    await expect(resolveConfigWriteTarget(join(dir, "link.json"))).rejects.toMatchObject({
      reason,
      name: "ConfigWriteTargetError",
    });
  });

  it("accepts a 40-hop chain and rejects a 41st hop", async () => {
    const dir = makeTempDir();
    const real = join(dir, "real.json");
    writeFileSync(real, "{}\n");
    let current = real;
    for (let index = 0; index < MAX_CONFIG_SYMLINK_HOPS; index += 1) {
      const next = join(dir, `link-${index}.json`);
      symlinkSync(current, next);
      current = next;
    }
    await expect(resolveConfigWriteTarget(current)).resolves.toMatchObject({
      writePath: realpathSync(real),
      terminalExisted: true,
    });

    const extra = join(dir, "link-extra.json");
    symlinkSync(current, extra);
    await expect(resolveConfigWriteTarget(extra)).rejects.toMatchObject({ reason: "depth" });
  });

  it("rejects a terminal it cannot inspect", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const hidden = join(dir, "hidden");
    const real = join(hidden, "opencode.json");
    const link = join(dir, "link.json");
    mkdirSync(hidden);
    writeFileSync(real, "{}\n");
    symlinkSync(real, link);
    chmodSync(hidden, 0);
    try {
      await expect(resolveConfigWriteTarget(link)).rejects.toMatchObject({
        reason: "permission",
      });
    } finally {
      chmodSync(hidden, 0o700);
    }
  });
});

describe("configWriteTargetsEqual", () => {
  it.each([
    ["../dotfiles/opencode.json", "..\\dotfiles\\opencode.json"],
    ["..\\dotfiles\\opencode.json", "../dotfiles/opencode.json"],
  ])("compares stored link text exactly: %s", (linkText, changedLinkText) => {
    const planned = {
      configuredPath: "config.json",
      writePath: "opencode.json",
      hops: [{ path: "config.json", linkText }],
      terminalExisted: true,
    };
    const current = { ...planned, hops: [{ ...planned.hops[0] }] };
    expect(configWriteTargetsEqual(planned, current)).toBe(true);

    current.hops[0].linkText = changedLinkText;
    expect(configWriteTargetsEqual(planned, current)).toBe(false);
  });
});

describe("writeResolvedConfigText", () => {
  /** A write target for a path that is not a symlink. */
  const plainTarget = (path: string, terminalExisted: boolean) => ({
    configuredPath: path,
    writePath: path,
    hops: [],
    terminalExisted,
  });

  it("preserves an existing file mode and creates new files restrictively", async () => {
    const dir = makeTempDir();
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "{}\n");
    if (process.platform !== "win32") {
      chmodSync(existing, 0o640);
    }
    await writeResolvedConfigText(plainTarget(existing, true), '{"ok":true}\n');
    if (process.platform !== "win32") {
      expect(lstatSync(existing).mode & 0o777).toBe(0o640);
    }

    const created = join(dir, "created.json");
    await writeResolvedConfigText(plainTarget(created, false), '{"ok":true}\n');
    if (process.platform !== "win32") {
      expect(lstatSync(created).mode & 0o777).toBe(NEW_CONFIG_FILE_MODE);
    }
  });

  it("does not delete the destination when rename fails", async () => {
    const dir = makeTempDir();
    const dest = join(dir, "opencode.json");
    mkdirSync(dest);
    writeFileSync(join(dest, "keep.txt"), "safe\n");

    await expect(
      writeResolvedConfigText(plainTarget(dest, false), '{"ok":true}\n'),
    ).rejects.toThrow();

    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, "keep.txt"), "utf8")).toBe("safe\n");
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
